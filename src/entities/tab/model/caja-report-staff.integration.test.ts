/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: get_caja_report's per-staff summary (wave 3a, the
 * report's staff-summary join). Before this wave, the staff summary independently LEFT JOINed
 * orders and payments to profiles, producing a cross-product per staff
 * member that multiplied salesTotal by the staff member's order count; the
 * fix aggregates orders and payments in separate subqueries first.
 *
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (local stack).
 * Skips gracefully when absent. get_caja_report is callable by the service
 * role directly, so no staff sign-in is needed.
 *
 * Run: npx vitest run src/entities/tab/model/caja-report-staff.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey;

const TAG = '__caja_report_staff_test__';

interface StaffFixture {
  id: string;
  name: string;
  email: string;
}

describe.skipIf(skip)("get_caja_report's staff summary", () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());

  const staffA: StaffFixture = { id: '', name: `${TAG}a`, email: `${TAG}a_${stamp}@test.local` };
  const staffB: StaffFixture = { id: '', name: `${TAG}b`, email: `${TAG}b_${stamp}@test.local` };
  const fixtures = [staffA, staffB];
  const tabIds: string[] = [];
  let cajaId = '';
  let shiftAId = '';
  let shiftBId = '';

  async function makeStaff(f: StaffFixture): Promise<void> {
    const { data, error } = await db.auth.admin.createUser({ email: f.email, password: crypto.randomUUID(), email_confirm: true });
    if (error || !data.user) throw new Error(`create user ${f.name}: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db
      .from('profiles')
      .upsert({ id: f.id, name: f.name, email: f.email, role: 'cashier', pin: String(100000 + Math.floor(Math.random() * 900000)), is_active: true });
    if (profileErr) throw new Error(`profile upsert ${f.name}: ${profileErr.message}`);
  }

  async function removeStaff(f: StaffFixture): Promise<void> {
    if (!f.id) return;
    await db.from('profiles').delete().eq('id', f.id);
    await db.auth.admin.deleteUser(f.id);
  }

  /** A tab owned by staffMember with one order (by staffMember) and, when amount is given, one cash payment. */
  async function seedTab(staffMember: StaffFixture, shiftId: string, amount: number | null): Promise<string> {
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `${TAG}${Date.now()}`,
        staff_id: staffMember.id,
        shift_id: shiftId,
        caja_session_id: cajaId,
        status: amount !== null ? 'paid' : 'open',
        ...(amount !== null ? { closed_at: new Date().toISOString() } : {}),
      })
      .select('id')
      .single();
    if (tabErr || !tab) throw new Error(`tab insert: ${tabErr?.message}`);
    tabIds.push(tab.id);

    const { error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tab.id, staff_id: staffMember.id, status: amount !== null ? 'served' : 'pending' });
    if (orderErr) throw new Error(`order insert: ${orderErr.message}`);

    if (amount !== null) {
      const { error: payErr } = await db.from('payments').insert({
        tab_id: tab.id,
        amount,
        method: 'cash',
        processed_by: staffMember.id,
        idempotency_key: `${TAG}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
      if (payErr) throw new Error(`payment insert: ${payErr.message}`);
    }

    return tab.id as string;
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeStaff(f);

    const { data: shiftA, error: shiftAErr } = await db.from('shifts').insert({ staff_id: staffA.id, opening_cash: 0 }).select('id').single();
    if (shiftAErr || !shiftA) throw new Error(`shift A insert: ${shiftAErr?.message}`);
    shiftAId = shiftA.id as string;

    const { data: shiftB, error: shiftBErr } = await db.from('shifts').insert({ staff_id: staffB.id, opening_cash: 0 }).select('id').single();
    if (shiftBErr || !shiftB) throw new Error(`shift B insert: ${shiftBErr?.message}`);
    shiftBId = shiftB.id as string;

    // Seeded 'closed', mirroring hourly-breakdown.integration.test.ts, to
    // avoid a possible unique-open-caja-per-terminal conflict.
    const { data: caja, error: cajaErr } = await db
      .from('caja_sessions')
      .insert({ opened_by: staffA.id, opening_cash: 0, status: 'closed', closed_at: new Date().toISOString() })
      .select('id')
      .single();
    if (cajaErr || !caja) throw new Error(`caja insert: ${cajaErr?.message}`);
    cajaId = caja.id as string;
  });

  afterAll(async () => {
    for (const tabId of tabIds) {
      const { data: orders } = await db.from('orders').select('id').eq('tab_id', tabId);
      const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
      if (orderIds.length > 0) await db.from('order_items').delete().in('order_id', orderIds);
      await db.from('payments').delete().eq('tab_id', tabId);
      await db.from('orders').delete().eq('tab_id', tabId);
      await db.from('tabs').delete().eq('id', tabId);
    }
    if (cajaId) await db.from('caja_sessions').delete().eq('id', cajaId);
    if (shiftAId) await db.from('shifts').delete().eq('id', shiftAId);
    if (shiftBId) await db.from('shifts').delete().eq('id', shiftBId);
    for (const f of fixtures) await removeStaff(f);
  });

  it('aggregates orderCount and salesTotal per staff member without a join cross-product', async () => {
    await seedTab(staffA, shiftAId, 100);
    await seedTab(staffA, shiftAId, 50);
    await seedTab(staffB, shiftBId, null);

    const { data, error } = await db.rpc('get_caja_report', { p_caja_id: cajaId });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);

    const rows: Array<{ staffId: string; orderCount: number; salesTotal: number }> = data.staffSummary;

    const rowA = rows.find((r) => r.staffId === staffA.id);
    expect(rowA).toBeDefined();
    expect(rowA!.orderCount).toBe(2);
    expect(Number(rowA!.salesTotal)).toBe(150);

    const rowB = rows.find((r) => r.staffId === staffB.id);
    expect(rowB).toBeDefined();
    expect(rowB!.orderCount).toBe(1);
    expect(Number(rowB!.salesTotal)).toBe(0);
  });
});

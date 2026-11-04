/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';

/**
 * Integration test: the kitchen role no longer exists in the database (D29).
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (dev2).
 * Run: npx vitest run --project integration src/entities/staff/model/kitchen-role-retired.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;
const TAG = '__kitchen_retired_test__';

interface TestUser { id: string; name: string; email: string; role: string; pin: string; client: any }

describe.skipIf(skip)('kitchen role retired', () => {
  it('targets the local dev2 API', () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
  });

  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const mk = (k: string, role: string): TestUser => ({ id: '', name: `${TAG}${k}`, email: `${TAG}${k}_${stamp}@test.local`, role, pin: '', client: null });
  const admin = mk('admin', 'admin');
  const manager = mk('manager', 'manager');
  const cashier = mk('cashier', 'cashier');
  const target = mk('target', 'cashier');
  const users = [admin, manager, cashier, target];
  const roles = ['cashier', 'manager', 'admin'];
  const tabIds: string[] = [];
  let shiftId = '';
  const baseline: Record<string, number> = {};

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of roles) {
      const { count } = await db.from('role_permissions').select('*', { count: 'exact', head: true }).eq('role', r);
      out[r] = count ?? -1;
    }
    return out;
  }

  async function unusedPin(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const candidate = String(100000 + Math.floor(Math.random() * 900000));
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('pin', candidate);
      if (count === 0) return candidate;
    }
    throw new Error('no unused pin found');
  }

  async function makeUser(u: TestUser): Promise<void> {
    u.pin = await unusedPin();
    const newId = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ id: newId, email: u.email, password: await deriveStaffPassword(newId, u.pin), email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    u.id = data.user.id as string;
    const { error: pe } = await db.from('profiles').upsert({ id: u.id, name: u.name, email: u.email, role: u.role, pin: u.pin, is_active: true });
    if (pe) throw new Error(`profile upsert: ${pe.message}`);
  }

  async function signIn(u: TestUser): Promise<void> {
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ staffId: u.id, pin: u.pin }),
    });
    const json = await res.json();
    if (res.status !== 200) throw new Error(`sign in ${u.name}: ${res.status}`);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error } = await u.client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (error) throw new Error(`setSession ${u.name}: ${error.message}`);
  }

  beforeAll(async () => {
    Object.assign(baseline, await counts());
    for (const u of users) await makeUser(u);
    await signIn(admin);
    await signIn(cashier);
    const { data: shift, error } = await db.from('shifts').insert({ staff_id: cashier.id, opening_cash: 0 }).select('id').single();
    if (error) throw new Error(`shift: ${error.message}`);
    shiftId = shift.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of tabIds) {
      const { data: orders } = await db.from('orders').select('id').eq('tab_id', id);
      for (const o of orders ?? []) await db.from('order_items').delete().eq('order_id', o.id);
      await db.from('orders').delete().eq('tab_id', id);
      await db.from('payments').delete().eq('tab_id', id);
      await db.from('tabs').delete().eq('id', id);
    }
    if (shiftId) await db.from('shifts').delete().eq('id', shiftId);
    const ids = users.map((u) => u.id).filter(Boolean);
    await db.from('audit_logs').delete().in('actor_id', ids);
    for (const u of users) {
      if (!u.id) continue;
      await db.from('pin_attempts').delete().like('attempt_key', `%${u.id}%`);
      // The cashier's order_item insert/delete writes a net-zero sale/correction pair to the ledger;
      // its staff_id FK would block the profile delete, and the pair changes no stock.
      await db.from('stock_movements').delete().eq('staff_id', u.id);
      const pd = await db.from('profiles').delete().eq('id', u.id);
      if (pd.error) throw new Error(`cleanup profile ${u.name}: ${pd.error.message}`);
      const ud = await db.auth.admin.deleteUser(u.id);
      if (ud.error) throw new Error(`cleanup auth user ${u.name}: ${ud.error.message}`);
    }
  }, 60_000);

  it('the service client cannot insert or update a profile to role kitchen', async () => {
    const upd = await db.from('profiles').update({ role: 'kitchen' }).eq('id', target.id);
    expect(upd.error?.code).toBe('23514');
    expect(upd.error?.message).toContain('profiles_role_not_kitchen');
    const ins = await db.from('profiles').insert({ id: randomUUID(), name: `${TAG}ins`, email: `${TAG}ins@test.local`, role: 'kitchen', pin: await unusedPin() });
    expect(ins.error?.code).toBe('23514');
    expect(ins.error?.message).toContain('profiles_role_not_kitchen');
    const { data } = await db.from('profiles').select('role').eq('id', target.id).single();
    expect(data.role).toBe('cashier');
  });

  it('an admin session cannot set a staff member to kitchen through the client', async () => {
    const bad = await admin.client.from('profiles').update({ role: 'kitchen' }).eq('id', target.id);
    expect(bad.error?.code).toBe('23514');
    for (const r of ['manager', 'admin', 'cashier']) {
      const ok = await admin.client.from('profiles').update({ role: r }).eq('id', target.id).select('role');
      expect(ok.error).toBeNull();
      expect(ok.data?.[0]?.role).toBe(r);
    }
  });

  it('role_permissions refuses a kitchen row', async () => {
    const svc = await db.from('role_permissions').insert({ role: 'kitchen', action: 'clock_in' });
    expect(svc.error?.code).toBe('23514');
    expect(svc.error?.message).toContain('role_permissions_role_not_kitchen');
    // The toggle-permission path: client insert of { role, action } as an admin session.
    const viaToggle = await admin.client.from('role_permissions').insert({ role: 'kitchen', action: 'clock_in' }).select().single();
    expect(viaToggle.error?.code).toBe('23514');
    expect(viaToggle.error?.message).toContain('role_permissions_role_not_kitchen');
    const { count } = await db.from('role_permissions').select('*', { count: 'exact', head: true }).eq('role', 'kitchen');
    expect(count).toBe(0);
  });

  it('a cashier still reads and writes what it did before', async () => {
    const tab = await cashier.client.from('tabs').insert({ customer_name: `${TAG}tab`, staff_id: cashier.id, shift_id: shiftId, status: 'open' }).select('id').single();
    expect(tab.error).toBeNull();
    tabIds.push(tab.data.id);
    const mine = await cashier.client.from('tabs').select('id').eq('id', tab.data.id);
    expect(mine.data).toHaveLength(1);
    const order = await cashier.client.from('orders').insert({ tab_id: tab.data.id, staff_id: cashier.id, status: 'pending' }).select('id').single();
    expect(order.error).toBeNull();
    // A product that really has stock, so the sale cannot fail on INVENTORY_NEGATIVE.
    const { data: inv } = await db.from('inventory').select('product_id').gte('quantity_on_hand', 5).limit(1).single();
    const { data: prod } = await db.from('products').select('id,base_price').eq('id', inv.product_id).single();
    const item = await cashier.client.from('order_items').insert({ order_id: order.data.id, product_id: prod.id, quantity: 1, unit_price: prod.base_price }).select('id').single();
    expect(item.error).toBeNull();
    const pay = await cashier.client.from('payments').select('id').eq('tab_id', tab.data.id);
    expect(pay.error).toBeNull();
  });

  it('a cashier without close_tab is still refused payments select', async () => {
    const { data: tab } = await db.from('tabs').insert({ customer_name: `${TAG}paytab`, staff_id: cashier.id, shift_id: shiftId, status: 'open' }).select('id').single();
    tabIds.push(tab.id);
    const { data: pay, error: pe } = await db.from('payments').insert({ tab_id: tab.id, amount: 1, method: 'cash', processed_by: cashier.id, idempotency_key: randomUUID() }).select('id').single();
    try {
      expect(pe).toBeNull();
      const withPerm = await cashier.client.from('payments').select('id').eq('id', pay.id);
      expect(withPerm.data).toHaveLength(1);
      const del = await db.from('role_permissions').delete().eq('role', 'cashier').eq('action', 'close_tab');
      expect(del.error).toBeNull();
      const without = await cashier.client.from('payments').select('id').eq('id', pay.id);
      expect(without.data ?? []).toHaveLength(0);
    } finally {
      const restored = await db.from('role_permissions').upsert({ role: 'cashier', action: 'close_tab' }, { onConflict: 'role,action' });
      if (restored.error) throw new Error(`restore cashier/close_tab: ${restored.error.message}`);
    }
  });

  it('cashier, manager and admin keep their permission counts', async () => {
    expect(await counts()).toEqual(baseline);
  });

  it('open_open_unit and remove_tab_item work for a cashier and refuse a caller without an active role', async () => {
    // The role guard passes for an active cashier; the random product then fails validation.
    const ok = await cashier.client.rpc('open_open_unit', { p_product_id: randomUUID() });
    expect(ok.error?.message ?? '').toContain('VALIDATION_ERROR');
    expect(ok.error?.message ?? '').not.toContain('AUTH_FORBIDDEN');
    // An active cashier passes the remove_tab_item guard and gets a NOT_FOUND result, not AUTH_FORBIDDEN.
    const gone = await cashier.client.rpc('remove_tab_item', { p_item_id: randomUUID(), p_reason: 'x' });
    expect(gone.error).toBeNull();
    expect(gone.data?.code).toBe('NOT_FOUND');
    // deplete_for_order_item: guard passes for a cashier; an unknown item returns without error.
    const dep = await cashier.client.rpc('deplete_for_order_item', { p_order_item_id: randomUUID(), p_direction: 1 });
    expect(dep.error?.message ?? '').not.toContain('AUTH_FORBIDDEN');
    // A deactivated profile has a NULL get_user_role(): the allow-list refuses it.
    await db.from('profiles').update({ is_active: false }).eq('id', cashier.id);
    try {
      const refused = await cashier.client.rpc('open_open_unit', { p_product_id: randomUUID() });
      expect(refused.error?.message).toContain('AUTH_FORBIDDEN');
      const removed = await cashier.client.rpc('remove_tab_item', { p_item_id: randomUUID(), p_reason: 'x' });
      expect(removed.error?.message ?? '').toContain('AUTH_FORBIDDEN');
      // NOTE: the guards' `NOT IN (...)` branch for an unknown role is unreachable from
      // supabase-js now that profiles_role_not_kitchen exists; deactivation (NULL role) is the testable refusal.
      const depRefused = await cashier.client.rpc('deplete_for_order_item', { p_order_item_id: randomUUID(), p_direction: 1 });
      expect(depRefused.error?.message ?? '').toContain('AUTH_FORBIDDEN');
    } finally {
      const back = await db.from('profiles').update({ is_active: true }).eq('id', cashier.id);
      if (back.error) throw new Error(`reactivate cashier: ${back.error.message}`);
    }
  });

  it('the reassignment audit rows keep their role keys', async () => {
    const { data, error } = await db.from('audit_logs').select('actor_id,source,before,after').eq('action', 'staff.role_reassigned');
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(row.actor_id).toBeNull();
      expect(row.source).toBe('rpc');
      expect(row.before.role).toBe('kitchen');
      expect(row.after.role).toBe('cashier');
    }
    // Same shape written now: the redact trigger must not strip the role keys.
    const ins = await db.from('audit_logs').insert({ actor_id: admin.id, action: `${TAG}role_probe`, entity_type: 'profiles', before: { role: 'kitchen' }, after: { role: 'cashier' }, source: 'rpc' }).select('id').single();
    expect(ins.error).toBeNull();
    try {
      const { data: back, error: be } = await db.from('audit_logs').select('before,after').eq('id', ins.data.id).single();
      expect(be).toBeNull();
      expect(back.before.role).toBe('kitchen');
      expect(back.after.role).toBe('cashier');
    } finally {
      await db.from('audit_logs').delete().eq('id', ins.data.id); // afterAll also sweeps by actor_id
    }
  });
});

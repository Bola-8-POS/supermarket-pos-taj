/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: approval tickets on the override RPCs.
 *
 * The manager prompt's server check (verify_staff_pin with p_required_action)
 * issues a single-use ticket bound to the caller and the action; the override
 * RPCs consume it through p_approval_id (plus p_approver_id).
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack with the edge runtime running). Skips gracefully when absent.
 *
 * Run: npx vitest run src/entities/payment/model/manager-approvals.integration.test.ts --project integration
 * Note: the local Auth service allows 30 sign-ins per 5 minutes per address;
 * this file performs four.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__manager_approvals_test__';

interface TestUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'cashier';
  pin: string;
  client: any;
}

interface PaidTab {
  tabId: string;
  paymentId: string;
  itemIds: string[];
}

describe.skipIf(skip)('manager approvals', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const cashier: TestUser = { id: '', name: `${TAG}cashier`, email: `${TAG}c_${stamp}@test.local`, role: 'cashier', pin: '', client: null };
  const managerA: TestUser = { id: '', name: `${TAG}managerA`, email: `${TAG}ma_${stamp}@test.local`, role: 'manager', pin: '', client: null };
  const managerB: TestUser = { id: '', name: `${TAG}managerB`, email: `${TAG}mb_${stamp}@test.local`, role: 'manager', pin: '', client: null };
  const admin: TestUser = { id: '', name: `${TAG}admin`, email: `${TAG}ad_${stamp}@test.local`, role: 'admin', pin: '', client: null };
  const users = [cashier, managerA, managerB, admin];
  const tabIds: string[] = [];
  let shiftId = '';

  async function unusedPin(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const candidate = String(100000 + Math.floor(Math.random() * 900000));
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('pin', candidate);
      if (count === 0) return candidate;
    }
    throw new Error('no unused pin found');
  }

  async function callFn(name: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  /** Creates the auth user (password = PIN, as create-staff does), the profile, and a signed-in client. */
  async function makeUser(u: TestUser, pin?: string): Promise<void> {
    u.pin = pin ?? (await unusedPin());
    const { data, error } = await db.auth.admin.createUser({ email: u.email, password: u.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    u.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: u.id, name: u.name, email: u.email, role: u.role, pin: u.pin, is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    const signedIn = await callFn('staff-sign-in', anonKey!, { staffId: u.id, pin: u.pin });
    if (signedIn.status !== 200) throw new Error(`sign in for ${u.name}: ${signedIn.status}`);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: sessionErr } = await u.client.auth.setSession({
      access_token: signedIn.json.accessToken, refresh_token: signedIn.json.refreshToken,
    });
    if (sessionErr) throw new Error(`setSession for ${u.name}: ${sessionErr.message}`);
  }

  async function removeUser(u: TestUser): Promise<void> {
    if (!u.id) return;
    const { error: attemptsErr } = await db.from('pin_attempts').delete().like('attempt_key', `%${u.id}%`);
    expect(attemptsErr, `pin_attempts cleanup for ${u.name}`).toBeNull();
    const { error: ticketsErr } = await db.from('manager_approvals').delete().eq('caller_id', u.id);
    expect(ticketsErr, `manager_approvals cleanup for ${u.name}`).toBeNull();
    const { error: profileErr } = await db.from('profiles').delete().eq('id', u.id);
    expect(profileErr, `profile delete for ${u.name}`).toBeNull();
    const { error: authErr } = await db.auth.admin.deleteUser(u.id);
    expect(authErr, `auth user delete for ${u.name}`).toBeNull();
  }

  /** The manager prompt's server check, run with the caller's session: returns the ticket id. */
  async function ticket(caller: TestUser, pin: string, action: string): Promise<string> {
    const { data, error } = await caller.client.rpc('verify_staff_pin', { p_pin: pin, p_staff_id: null, p_required_action: action });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(typeof data.approval_id).toBe('string');
    return data.approval_id as string;
  }

  async function ticketRow(id: string): Promise<{ caller_id: string; action: string; approver_ids: string[]; consumed_at: string | null }> {
    const { data, error } = await db.from('manager_approvals').select('caller_id, action, approver_ids, consumed_at').eq('id', id).single();
    expect(error).toBeNull();
    return data;
  }

  /** A paid tab owned by the cashier with five $10 lines and one $50 cash payment. */
  async function seedPaidTab(): Promise<PaidTab> {
    const { data: product } = await db.from('products').select('id').eq('is_active', true).limit(1).single();
    if (!product) throw new Error('no active product');
    const { data: tab, error: tabErr } = await db.from('tabs').insert({
      customer_name: `${TAG}${Date.now()}`, staff_id: cashier.id, shift_id: shiftId, status: 'paid', closed_at: new Date().toISOString(),
    }).select('id').single();
    if (tabErr || !tab) throw new Error(`tab insert: ${tabErr?.message}`);
    tabIds.push(tab.id);
    const { data: order, error: orderErr } = await db.from('orders').insert({ tab_id: tab.id, staff_id: cashier.id, status: 'served' }).select('id').single();
    if (orderErr || !order) throw new Error(`order insert: ${orderErr?.message}`);
    const { data: items, error: itemErr } = await db.from('order_items').insert(
      Array.from({ length: 5 }, () => ({ order_id: order.id, product_id: product.id, quantity: 1, unit_price: 10.0, modifier_price_delta: 0 })),
    ).select('id');
    if (itemErr || !items) throw new Error(`items insert: ${itemErr?.message}`);
    const { data: payment, error: payErr } = await db.from('payments').insert({
      tab_id: tab.id, amount: 50.0, method: 'cash', processed_by: cashier.id, idempotency_key: `${TAG}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }).select('id').single();
    if (payErr || !payment) throw new Error(`payment insert: ${payErr?.message}`);
    return { tabId: tab.id, paymentId: payment.id, itemIds: items.map((i: { id: string }) => i.id) };
  }

  /** An open tab owned by the cashier with one $40 line. */
  async function seedOpenTab(): Promise<string> {
    const { data: product } = await db.from('products').select('id').eq('is_active', true).limit(1).single();
    if (!product) throw new Error('no active product');
    const { data: tab, error: tabErr } = await db.from('tabs').insert({
      customer_name: `${TAG}${Date.now()}`, staff_id: cashier.id, shift_id: shiftId, status: 'open',
    }).select('id').single();
    if (tabErr || !tab) throw new Error(`tab insert: ${tabErr?.message}`);
    tabIds.push(tab.id);
    const { data: order, error: orderErr } = await db.from('orders').insert({ tab_id: tab.id, staff_id: cashier.id, status: 'pending' }).select('id').single();
    if (orderErr || !order) throw new Error(`order insert: ${orderErr?.message}`);
    const { error: itemErr } = await db.from('order_items').insert({ order_id: order.id, product_id: product.id, quantity: 1, unit_price: 40.0, modifier_price_delta: 0 });
    if (itemErr) throw new Error(`item insert: ${itemErr.message}`);
    return tab.id;
  }

  function refundArgs(tab: PaidTab, approvalId: string | null, approverId: string | null) {
    return {
      p_original_payment_id: tab.paymentId,
      p_items: [{ order_item_id: tab.itemIds[0], qty: 1, amount: 10.0, restock: false }],
      p_reason: 'other',
      p_approval_id: approvalId,
      p_approver_id: approverId,
    };
  }

  function paymentArgs(tabId: string, approvalId: string | null, approverId: string | null, idempotencyKey?: string) {
    return {
      p_tab_id: tabId,
      p_staff_id: cashier.id,
      p_amount: 36.0,
      p_method: 'cash',
      p_idempotency_key: idempotencyKey ?? `${TAG}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      p_tendered_amount: 40.0,
      p_discount_scope: 'all',
      p_discount_type: 'percent',
      p_discount_value: 10,
      p_discount_amount: 4.0,
      p_manager_override: true,
      p_approval_id: approvalId,
      p_approver_id: approverId,
    };
  }

  async function refundCount(tab: PaidTab): Promise<number> {
    const { count } = await db.from('refunds').select('id', { count: 'exact', head: true }).eq('original_payment_id', tab.paymentId);
    return count ?? 0;
  }

  async function paymentCount(tabId: string): Promise<number> {
    const { count } = await db.from('payments').select('id', { count: 'exact', head: true }).eq('tab_id', tabId);
    return count ?? 0;
  }

  beforeAll(async () => {
    await makeUser(cashier);
    await makeUser(managerA);
    await makeUser(managerB, managerA.pin); // shares a PIN with manager A
    await makeUser(admin);
    const { data: shift, error } = await db.from('shifts').insert({ staff_id: cashier.id, opening_cash: 0 }).select('id').single();
    if (error || !shift) throw new Error(`shift insert: ${error?.message}`);
    shiftId = shift.id;
  });

  afterAll(async () => {
    for (const tabId of tabIds) {
      const tabPaymentIds = (await db.from('payments').select('id').eq('tab_id', tabId)).data?.map((p: { id: string }) => p.id) ?? [];
      // payments.refund_id and refunds.original_payment_id reference each
      // other (both RESTRICT), so the refund-tracking payment row has to go
      // before the refund it points to.
      expect((await db.from('payments').delete().eq('tab_id', tabId).eq('is_refund', true)).error).toBeNull();
      expect((await db.from('refunds').delete().in('original_payment_id', tabPaymentIds)).error).toBeNull();
      expect((await db.from('payments').delete().eq('tab_id', tabId)).error).toBeNull();
      const orderIds = (await db.from('orders').select('id').eq('tab_id', tabId)).data?.map((o: { id: string }) => o.id) ?? [];
      expect((await db.from('order_items').delete().in('order_id', orderIds)).error).toBeNull();
      expect((await db.from('orders').delete().eq('tab_id', tabId)).error).toBeNull();
      expect((await db.from('tabs').delete().eq('id', tabId)).error).toBeNull();
    }
    if (shiftId) expect((await db.from('shifts').delete().eq('id', shiftId)).error).toBeNull();

    // The payment and direct-sale paths write stock_movements rows for the
    // cashier (via the order_items trigger), and process_refund writes a
    // legacy audit_log row for the approver. Both carry a RESTRICT/NO ACTION
    // foreign key to profiles, so clear them before removing the profiles.
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length > 0) {
      expect((await db.from('stock_movements').delete().in('staff_id', ids)).error).toBeNull();
      expect((await db.from('audit_log').delete().in('actor_id', ids)).error).toBeNull();
    }
    for (const u of users) await removeUser(u);

    // Every tagged fixture must be gone (audit rows may stay).
    const { count: profiles } = await db.from('profiles').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(profiles).toBe(0);
    const { count: tabs } = await db.from('tabs').select('id', { count: 'exact', head: true }).like('customer_name', `${TAG}%`);
    expect(tabs).toBe(0);
    if (ids.length > 0) {
      const { count: tickets } = await db.from('manager_approvals').select('id', { count: 'exact', head: true }).in('caller_id', ids);
      expect(tickets).toBe(0);
    }
  });

  it('issues a ticket bound to the caller and the action, carrying every eligible holder', async () => {
    const id = await ticket(cashier, managerA.pin, 'process_refund');
    const row = await ticketRow(id);
    expect(row.caller_id).toBe(cashier.id);
    expect(row.action).toBe('process_refund');
    expect([...row.approver_ids].sort()).toEqual([managerA.id, managerB.id].sort());
    expect(row.consumed_at).toBeNull();

    // Without p_required_action no ticket is issued.
    const { data: plain } = await cashier.client.rpc('verify_staff_pin', { p_pin: managerA.pin, p_staff_id: managerA.id });
    expect(plain.ok).toBe(true);
    expect(plain.approval_id).toBeUndefined();

    // A PIN nobody eligible holds issues nothing.
    const { data: refused } = await cashier.client.rpc('verify_staff_pin', { p_pin: cashier.pin, p_staff_id: null, p_required_action: 'process_refund' });
    expect(refused).toMatchObject({ ok: false, code: 'INVALID_PIN' });
    await cashier.client.rpc('verify_staff_pin', { p_pin: managerA.pin, p_staff_id: managerA.id }); // clears the counted attempt
  });

  it('approves a discounted payment with a valid ticket and records the approver', async () => {
    const tabId = await seedOpenTab();
    const id = await ticket(cashier, managerA.pin, 'apply_custom_discount');
    const { data, error } = await db.rpc('process_payment_atomic', paymentArgs(tabId, id, managerA.id));
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    const { data: payment } = await db.from('payments').select('approved_by, processed_by').eq('id', data.paymentId).single();
    expect(payment).toEqual({ approved_by: managerA.id, processed_by: cashier.id });
    const { data: audit } = await db.from('audit_logs').select('after').eq('action', 'payment.process').eq('entity_id', data.paymentId).single();
    expect(audit.after.approved_by).toBe(managerA.id);
    expect((await ticketRow(id)).consumed_at).not.toBeNull();
  });

  it('refuses the same ticket a second time', async () => {
    const tabId = await seedOpenTab();
    const id = await ticket(cashier, managerA.pin, 'apply_custom_discount');
    const first = await db.rpc('process_payment_atomic', paymentArgs(tabId, id, managerA.id));
    expect(first.data.ok).toBe(true);

    const second = await seedOpenTab();
    const { data, error } = await db.rpc('process_payment_atomic', paymentArgs(second, id, managerA.id));
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await paymentCount(second)).toBe(0);
  });

  it('replays a committed payment with its consumed ticket as idempotent', async () => {
    const tabId = await seedOpenTab();
    const id = await ticket(cashier, managerA.pin, 'apply_custom_discount');
    const key = `${TAG}replay-${stamp}`;
    const first = await db.rpc('process_payment_atomic', paymentArgs(tabId, id, managerA.id, key));
    expect(first.data.ok).toBe(true);
    const { data, error } = await db.rpc('process_payment_atomic', paymentArgs(tabId, id, managerA.id, key));
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, idempotent: true, paymentId: first.data.paymentId });
    expect(await paymentCount(tabId)).toBe(1);
  });

  it('refuses a ticket issued for another action and leaves it unused', async () => {
    const tab = await seedPaidTab();
    const id = await ticket(cashier, managerA.pin, 'reopen_tab');
    const { data, error } = await cashier.client.rpc('process_refund', refundArgs(tab, id, managerA.id));
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await refundCount(tab)).toBe(0);
    expect((await ticketRow(id)).consumed_at).toBeNull();
  });

  it('refuses a ticket issued to another caller', async () => {
    const tab = await seedPaidTab();
    const id = await ticket(admin, managerA.pin, 'process_refund');
    const { data, error } = await cashier.client.rpc('process_refund', refundArgs(tab, id, managerA.id));
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await refundCount(tab)).toBe(0);
  });

  it('refuses a call without a ticket', async () => {
    const tab = await seedPaidTab();
    const { data, error } = await cashier.client.rpc('process_refund', refundArgs(tab, null, managerA.id));
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await refundCount(tab)).toBe(0);

    const tabId = await seedOpenTab();
    const { data: payment } = await db.rpc('process_payment_atomic', paymentArgs(tabId, null, managerA.id));
    expect(payment).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await paymentCount(tabId)).toBe(0);

    // A made-up ticket id is refused the same way.
    const { data: madeUp } = await db.rpc('process_payment_atomic', paymentArgs(tabId, crypto.randomUUID(), managerA.id));
    expect(madeUp).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('refuses an approver id the ticket does not carry, and needs one when two holders share the PIN', async () => {
    const tab = await seedPaidTab();
    const id = await ticket(cashier, managerA.pin, 'process_refund');
    const other = await cashier.client.rpc('process_refund', refundArgs(tab, id, admin.id));
    expect(other.error).toBeNull();
    expect(other.data).toBeNull();
    const nobody = await cashier.client.rpc('process_refund', refundArgs(tab, id, null));
    expect(nobody.error).toBeNull();
    expect(nobody.data).toBeNull();
    expect(await refundCount(tab)).toBe(0);
    expect((await ticketRow(id)).consumed_at).toBeNull();

    // Naming the holder the client picked works, and the session actor is the cashier.
    const { data: refundId, error } = await cashier.client.rpc('process_refund', refundArgs(tab, id, managerB.id));
    expect(error).toBeNull();
    const { data: refund } = await db.from('refunds').select('created_by').eq('id', refundId).single();
    expect(refund.created_by).toBe(managerB.id);
    const { data: audit } = await db.from('audit_logs').select('actor_id, after').eq('action', 'payment.refund').eq('entity_id', tab.paymentId).order('created_at', { ascending: false }).limit(1).single();
    expect(audit.actor_id).toBe(cashier.id);
    expect(audit.after.approved_by).toBe(managerB.id);
  });

  it('records no payment when a direct sale is refused, and stores the approver on the delegated payment when it succeeds', async () => {
    const { data: product } = await db.from('products').select('id, base_price').eq('is_active', true).eq('sold_by_weight', false).limit(1).single();
    if (!product) throw new Error('no active product');
    const { data: caja, error: cajaErr } = await db.from('caja_sessions').insert({ opened_by: managerA.id, opening_cash: 0, terminal_id: `T${stamp.slice(-8)}` }).select('id, terminal_id').single();
    if (cajaErr || !caja) throw new Error(`caja insert: ${cajaErr?.message}`);
    let saleTabId: string | null = null;
    try {
      const basePrice = Number(product.base_price);
      const discountAmount = Math.round(basePrice * 10) / 100;
      const total = Math.round((basePrice - discountAmount) * 100) / 100;
      const saleArgs = (approvalId: string | null) => ({
        p_staff_id: cashier.id,
        p_shift_id: shiftId,
        p_caja_session_id: caja.id,
        p_items: [{ product_id: product.id, quantity: 1, unit_price: basePrice, modifier_ids: [], modifier_price_delta: 0, notes: '' }],
        p_idempotency_key: `${TAG}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        p_method: 'cash',
        p_amount: total,
        p_tendered_amount: total,
        p_discount_scope: 'all',
        p_discount_type: 'percent',
        p_discount_value: 10,
        p_discount_amount: discountAmount,
        p_manager_override: true,
        p_approval_id: approvalId,
        p_approver_id: managerA.id,
        p_terminal_id: caja.terminal_id,
      });

      const { data: refused, error: refusedErr } = await db.rpc('process_direct_sale_atomic', saleArgs(null));
      expect(refusedErr).toBeNull();
      expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' });

      const id = await ticket(cashier, managerA.pin, 'apply_custom_discount');
      const { data, error } = await db.rpc('process_direct_sale_atomic', saleArgs(id));
      expect(error).toBeNull();
      expect(data.ok).toBe(true);
      saleTabId = data.tabId;
      tabIds.push(data.tabId);
      const { data: payment } = await db.from('payments').select('approved_by, processed_by').eq('id', data.paymentId).single();
      expect(payment).toEqual({ approved_by: managerA.id, processed_by: cashier.id });
      const { data: audit } = await db.from('audit_logs').select('actor_id, after').eq('action', 'payment.process').eq('entity_id', data.paymentId).single();
      expect(audit.after.approved_by).toBe(managerA.id);
      // Called with the service key, not a signed-in session: record_audit's auth.uid() is NULL.
      expect(audit.actor_id).toBeNull();
      expect((await ticketRow(id)).consumed_at).not.toBeNull();
    } finally {
      // caja_sessions (like tabs) carries the bump_version_on_update trigger,
      // and the tab the sale just created still references this caja: release
      // that reference (with its own version bump) before closing and deleting.
      if (saleTabId) {
        const { data: tabRow } = await db.from('tabs').select('version').eq('id', saleTabId).single();
        const tabVersion = ((tabRow as { version?: number } | null)?.version ?? 0) + 1;
        await db.from('tabs').update({ caja_session_id: null, version: tabVersion }).eq('id', saleTabId);
      }
      const { data: cajaRow } = await db.from('caja_sessions').select('version').eq('id', caja.id).single();
      const cajaVersion = ((cajaRow as { version?: number } | null)?.version ?? 0) + 1;
      await db.from('caja_sessions').update({ status: 'closed', closed_at: new Date().toISOString(), version: cajaVersion }).eq('id', caja.id);
      expect((await db.from('caja_sessions').delete().eq('id', caja.id)).error).toBeNull();
    }
  });

  it('stores the approver on every leg of a split payment', async () => {
    const tabId = await seedOpenTab();
    const id = await ticket(cashier, managerA.pin, 'apply_custom_discount');
    const { data, error } = await db.rpc('process_split_payment_atomic', {
      p_tab_id: tabId,
      p_staff_id: cashier.id,
      p_legs: [
        { method: 'cash', amount: 18, tenderedAmount: 18 },
        { method: 'cash', amount: 18, tenderedAmount: 18 },
      ],
      p_expected_total: 36,
      p_idempotency_key: `${TAG}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      p_discount_scope: 'all',
      p_discount_type: 'percent',
      p_discount_value: 10,
      p_discount_amount: 4.0,
      p_manager_override: true,
      p_approval_id: id,
      p_approver_id: managerA.id,
    });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    const { data: payments } = await db.from('payments').select('approved_by').eq('tab_id', tabId);
    expect(payments.length).toBe(2);
    expect(payments.every((p: { approved_by: string }) => p.approved_by === managerA.id)).toBe(true);
    const { data: audit } = await db.from('audit_logs').select('after').eq('action', 'payment.process_split').eq('entity_id', data.paymentGroupId).single();
    expect(audit.after.approved_by).toBe(managerA.id);
  });

  it('refuses a ticket whose approver was deactivated before use', async () => {
    const tab = await seedPaidTab();
    const id = await ticket(cashier, managerB.pin, 'process_refund');
    const { data: flipped, error: flipErr } = await db.rpc('set_staff_active', {
      p_staff_id: managerB.id, p_active: false, p_actor_id: admin.id, p_terminal_id: 'test',
    });
    expect(flipErr).toBeNull();
    expect(flipped).toMatchObject({ ok: true, changed: true });

    const { data, error } = await cashier.client.rpc('process_refund', refundArgs(tab, id, managerB.id));
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await refundCount(tab)).toBe(0);
    expect((await ticketRow(id)).consumed_at).toBeNull();
  });
});

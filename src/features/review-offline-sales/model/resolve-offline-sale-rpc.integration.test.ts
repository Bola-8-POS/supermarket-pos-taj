/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { unusedPin as unusedPinFor } from '../../../test/pin-helpers';

/**
 * Integration test: the resolve_offline_sale RPC (two-mode Plan 02c, Task 2).
 *
 * Users, sign-in and tickets follow src/entities/payment/model/manager-approvals.integration.test.ts.
 * The server rows the RPC looks up (tabs, order_items, payments) are seeded with the service role so the
 * idempotency key, seller and time are exact; the RPC only reads them.
 * Target: dev2 only (127.0.0.1:56321). Every client uses persistSession: false.
 *
 * dev2 is shared: the matrix rows touched by tests 6, 5 and 17 are restored in finally.
 *
 * Run: npx vitest run --project integration src/features/review-offline-sales/model/resolve-offline-sale-rpc.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__resolve_offline_sale_test__';
const ACTION = 'resolve_offline_sale';

interface TestUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'cashier';
  pin: string;
  client: any;
}

type Line = { product_id: string; quantity: number; modifier_ids: string[]; weight_grams: number | null };

describe.skipIf(skip)('resolve_offline_sale RPC', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const mk = (tag: string, role: TestUser['role']): TestUser => ({ id: '', name: `${TAG}${tag}`, email: `${TAG}${tag}_${stamp}@test.local`, role, pin: '', client: null });
  const cashier = mk('c', 'cashier');
  const cashier2 = mk('c2', 'cashier');
  const manager = mk('m', 'manager');
  const manager2 = mk('m2', 'manager');
  const cashier3 = mk('c3', 'cashier');
  const users = [cashier, cashier2, manager, manager2, cashier3];
  const tabIds: string[] = [];
  const saleIds: string[] = [];
  const grantIds: string[] = [];
  let shiftId = '';
  let productA = '';
  let productB = '';

  const unusedPin = (): Promise<string> => unusedPinFor(db);

  async function callFn(name: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function makeUser(u: TestUser): Promise<void> {
    u.pin = await unusedPin();
    const newId = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ id: newId, email: u.email, password: await deriveStaffPassword(newId, u.pin), email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    u.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({ id: u.id, name: u.name, email: u.email, role: u.role, pin: u.pin, is_active: true });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    const signedIn = await callFn('staff-sign-in', anonKey!, { staffId: u.id, pin: u.pin });
    if (signedIn.status !== 200) throw new Error(`sign in for ${u.name}: ${signedIn.status}`);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: sessionErr } = await u.client.auth.setSession({ access_token: signedIn.json.accessToken, refresh_token: signedIn.json.refreshToken });
    if (sessionErr) throw new Error(`setSession for ${u.name}: ${sessionErr.message}`);
  }

  async function removeUser(u: TestUser): Promise<void> {
    if (!u.id) return;
    await db.from('pin_attempts').delete().like('attempt_key', `%${u.id}%`);
    await db.from('manager_approvals').delete().eq('caller_id', u.id);
    await db.from('profiles').delete().eq('id', u.id);
    await db.auth.admin.deleteUser(u.id);
  }

  /** The manager prompt's server check, run with the caller's session: returns the ticket id. */
  async function ticket(caller: TestUser, approver: TestUser, action: string = ACTION): Promise<string> {
    const { data, error } = await caller.client.rpc('verify_staff_pin', { p_pin: approver.pin, p_staff_id: approver.id, p_required_action: action });
    expect(error).toBeNull();
    expect(data.ok, JSON.stringify(data)).toBe(true);
    return data.approval_id as string;
  }

  async function ticketRow(id: string): Promise<{ consumed_at: string | null; approver_ids: string[] }> {
    const { data, error } = await db.from('manager_approvals').select('approver_ids, consumed_at').eq('id', id).single();
    expect(error).toBeNull();
    return data;
  }

  const newSale = (): string => {
    const id = randomUUID();
    saleIds.push(id);
    return id;
  };
  const key = (): string => `${TAG}key_${randomUUID()}`;
  const lineA = (qty = 2): Line => ({ product_id: productA, quantity: qty, modifier_ids: [], weight_grams: null });
  const REASON = 'counted short, written off by hand';

  function args(over: Record<string, unknown> & { p_sale_id: string; p_approval_id: string | null }) {
    return {
      p_intent: 'write_off',
      p_idempotency_key: key(),
      p_rering_keys: [] as string[],
      p_lines: [lineA()],
      p_seller_id: cashier.id,
      p_recorded_tab_id: null,
      p_claim: { receiptNumber: 'R-1', total: 20, soldAt: new Date().toISOString(), terminalId: 'POS-T', lastCode: 'X', keyUntrusted: false },
      p_reason: REASON,
      p_approver_id: null,
      ...over,
    };
  }

  async function rpc(caller: TestUser, a: Record<string, unknown>): Promise<{ data: any; error: any }> {
    return caller.client.rpc(ACTION, a);
  }

  async function rowsFor(saleId: string): Promise<any[]> {
    const { data, error } = await db.from('audit_logs').select('*').eq('entity_type', 'offline_sale').eq('entity_id', saleId).order('created_at');
    expect(error).toBeNull();
    return data ?? [];
  }

  /** A server tab with payment(s) under `payKey`, the given goods and seller. Returns the tab id. */
  async function seedTab(payKey: string, opts: { seller?: TestUser; lines?: Line[]; processedAt?: string; legs?: boolean; splitOrderRows?: boolean } = {}): Promise<string> {
    const seller = opts.seller ?? cashier;
    const lines = opts.lines ?? [lineA()];
    const { data: tab, error: tabErr } = await db.from('tabs').insert({ customer_name: `${TAG}${Date.now()}`, staff_id: seller.id, shift_id: shiftId, status: 'paid', closed_at: new Date().toISOString() }).select('id').single();
    if (tabErr || !tab) throw new Error(`tab insert: ${tabErr?.message}`);
    tabIds.push(tab.id);
    const { data: order, error: orderErr } = await db.from('orders').insert({ tab_id: tab.id, staff_id: seller.id, status: 'served' }).select('id').single();
    if (orderErr || !order) throw new Error(`order insert: ${orderErr?.message}`);
    const rows: any[] = [];
    for (const l of lines) {
      const n = opts.splitOrderRows ? l.quantity : 1;
      for (let i = 0; i < n; i++) {
        rows.push({ order_id: order.id, product_id: l.product_id, quantity: opts.splitOrderRows ? 1 : l.quantity, unit_price: 10, modifier_price_delta: 0, modifier_ids: l.modifier_ids, weight_grams: l.weight_grams });
      }
    }
    const { error: itemErr } = await db.from('order_items').insert(rows);
    if (itemErr) throw new Error(`items insert: ${itemErr.message}`);
    const k = opts.legs ? `${payKey}-leg0` : payKey;
    const { error: payErr } = await db.from('payments').insert({
      tab_id: tab.id, amount: 20, method: 'cash', processed_by: seller.id, idempotency_key: k, processed_at: opts.processedAt ?? new Date().toISOString(),
    });
    if (payErr) throw new Error(`payment insert: ${payErr.message}`);
    return tab.id;
  }

  async function withMatrix<T>(rows: { role: string; action: string }[], mode: 'grant' | 'strip', fn: () => Promise<T>): Promise<T> {
    // grant: add rows that are missing; strip: delete rows that exist. Restored in finally.
    const touched: { role: string; action: string }[] = [];
    try {
      for (const r of rows) {
        const { data } = await db.from('role_permissions').select('role').eq('role', r.role).eq('action', r.action);
        const exists = (data ?? []).length > 0;
        if (mode === 'grant' && !exists) {
          expect((await db.from('role_permissions').insert(r)).error).toBeNull();
          touched.push(r);
        } else if (mode === 'strip' && exists) {
          expect((await db.from('role_permissions').delete().eq('role', r.role).eq('action', r.action)).error).toBeNull();
          touched.push(r);
        }
      }
      return await fn();
    } finally {
      for (const r of touched) {
        if (mode === 'grant') await db.from('role_permissions').delete().eq('role', r.role).eq('action', r.action);
        else await db.from('role_permissions').insert(r);
      }
    }
  }

  beforeAll(async () => {
    // Before any write: a wrong target must stop the suite, not just fail one test.
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
    for (const u of users) await makeUser(u);
    const { data: shift, error } = await db.from('shifts').insert({ staff_id: cashier.id, opening_cash: 0 }).select('id').single();
    if (error || !shift) throw new Error(`shift insert: ${error?.message}`);
    shiftId = shift.id;
    const { data: prods } = await db.from('products').select('id').eq('is_active', true).limit(2);
    if (!prods || prods.length < 2) throw new Error('need two active products');
    productA = prods[0].id;
    productB = prods[1].id;
  }, 120_000);

  afterAll(async () => {
    if (saleIds.length) await db.from('audit_logs').delete().eq('entity_type', 'offline_sale').in('entity_id', saleIds);
    for (const id of grantIds) await db.from('offline_approval_grants').delete().eq('id', id);
    for (const tabId of tabIds) {
      await db.from('payments').delete().eq('tab_id', tabId);
      const orderIds = (await db.from('orders').select('id').eq('tab_id', tabId)).data?.map((o: { id: string }) => o.id) ?? [];
      if (orderIds.length) await db.from('order_items').delete().in('order_id', orderIds);
      await db.from('orders').delete().eq('tab_id', tabId);
      await db.from('tabs').delete().eq('id', tabId);
    }
    if (shiftId) await db.from('shifts').delete().eq('id', shiftId);
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length) {
      await db.from('stock_movements').delete().in('staff_id', ids);
      await db.from('audit_logs').delete().in('actor_id', ids);
    }
    for (const u of users) await removeUser(u);
  });

  it('targets the dev2 local stack (127.0.0.1:56321), never another database', () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
  });

  it('a write-off with a manager ticket writes one offline_sale.written_off row and spends the ticket', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const { data, error } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, outcome: 'written_off', approverId: manager.id, idempotent: false });
    const rows = await rowsFor(sale);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'offline_sale.written_off', actor_id: cashier.id, source: 'rpc', terminal_id: 'POS-T' });
    expect(rows[0].after).toMatchObject({ approverId: manager.id, approvalId: t, outcome: 'written_off', manualResponsibility: 'cash_and_stock', reason: REASON });
    expect(rows[0].after.claimed).toMatchObject({ total: 20, sellerId: cashier.id, receiptNumber: 'R-1' });
    expect(rows[0].id).toBe(data.auditId);
    expect((await ticketRow(t)).consumed_at).not.toBeNull();
  });

  it('an approver id that is not on the ticket is refused', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager2.id }));
    expect(data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });
    expect(await rowsFor(sale)).toHaveLength(0);
    expect((await ticketRow(t)).consumed_at).toBeNull();
  });

  it("refuses no ticket, another session's ticket, a ticket for another action, a ticket spent on another sale and one older than 15 minutes", async () => {
    const sale = newSale();
    const none = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: null }));
    expect(none.data).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });

    const other = await ticket(cashier2, manager);
    const otherSession = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: other, p_approver_id: manager.id }));
    expect(otherSession.data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });

    const refundTicket = await ticket(cashier, manager, 'process_refund');
    const wrongAction = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: refundTicket, p_approver_id: manager.id }));
    expect(wrongAction.data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });

    const spent = await ticket(cashier, manager);
    const first = await rpc(cashier, args({ p_sale_id: newSale(), p_approval_id: spent, p_approver_id: manager.id }));
    expect(first.data.ok).toBe(true);
    const onAnotherSale = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: spent, p_approver_id: manager.id }));
    expect(onAnotherSale.data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });

    const old = await ticket(cashier, manager);
    expect((await db.from('manager_approvals').update({ created_at: new Date(Date.now() - 16 * 60_000).toISOString() }).eq('id', old)).error).toBeNull();
    const expired = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: old, p_approver_id: manager.id }));
    expect(expired.data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });

    expect(await rowsFor(sale)).toHaveLength(0);
  });

  it('refuses when the approver was deactivated or lost the action after the PIN', async () => {
    await withMatrix([{ role: 'cashier', action: ACTION }, { role: 'cashier', action: 'adjust_inventory' }], 'grant', async () => {
      const sale = newSale();
      const t = await ticket(cashier, cashier3);
      const stripped = await withMatrix([{ role: 'cashier', action: ACTION }], 'strip', () =>
        rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: cashier3.id })));
      expect(stripped.data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });
      expect((await ticketRow(t)).consumed_at).toBeNull();
    });
    const sale = newSale();
    const t = await ticket(cashier, manager2);
    try {
      expect((await db.from('profiles').update({ is_active: false }).eq('id', manager2.id)).error).toBeNull();
      const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager2.id }));
      expect(data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });
    } finally {
      await db.from('profiles').update({ is_active: true }).eq('id', manager2.id);
    }
    expect(await rowsFor(sale)).toHaveLength(0);
    expect((await ticketRow(t)).consumed_at).toBeNull();
  });

  it('an offline approval grant id is not accepted', async () => {
    const { data: grant, error } = await db.from('offline_approval_grants')
      .insert({ action: 'process_refund', terminal_id: 'POS-T', granted_by: manager.id, expires_at: new Date(Date.now() + 3600_000).toISOString() }).select('id').single();
    expect(error).toBeNull();
    grantIds.push(grant.id);
    const sale = newSale();
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: grant.id, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: false, code: 'INVALID_APPROVAL' });
    expect(await rowsFor(sale)).toHaveLength(0);
    const { data: after } = await db.from('offline_approval_grants').select('consumed_at').eq('id', grant.id).single();
    expect(after.consumed_at).toBeNull();
  });

  it('a role customised with adjust_inventory before the migration can approve; one without the action cannot', async () => {
    // A plain cashier holds neither action: its PIN is not a match for the action.
    const without = await cashier.client.rpc('verify_staff_pin', { p_pin: cashier3.pin, p_staff_id: cashier3.id, p_required_action: ACTION });
    expect(without.data?.ok).toBe(false);
    expect(without.data?.code).toBe('INVALID_PIN');
    // The migration copies resolve_offline_sale to every adjust_inventory holder: model that copy for the cashier role.
    await withMatrix([{ role: 'cashier', action: 'adjust_inventory' }, { role: 'cashier', action: ACTION }], 'grant', async () => {
      const t = await ticket(cashier, cashier3);
      const sale = newSale();
      const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: cashier3.id }));
      expect(data).toMatchObject({ ok: true, outcome: 'written_off', approverId: cashier3.id });
    });
  });

  it('a repeated write-off returns written_off idempotent and writes no second row, with the spent ticket or a new one', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const first = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(first.data.ok).toBe(true);
    const again = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(again.data).toMatchObject({ ok: true, outcome: 'written_off', idempotent: true, auditId: first.data.auditId });
    const t2 = await ticket(cashier, manager);
    const withNew = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t2, p_approver_id: manager.id }));
    expect(withNew.data).toMatchObject({ ok: true, outcome: 'written_off', idempotent: true });
    expect(await rowsFor(sale)).toHaveLength(1);
    expect((await ticketRow(t2)).consumed_at).toBeNull();
  });

  it('a repeated rering / review / linked call with the spent ticket returns the first outcome and writes no second row', async () => {
    for (const [intent, outcome, action] of [['rering', 'proceed', 'offline_sale.rering_approved'], ['review', 'moved_to_review', 'offline_sale.escalated']] as const) {
      const sale = newSale();
      const t = await ticket(cashier, manager);
      const a = args({ p_intent: intent, p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null });
      const first = await rpc(cashier, a);
      expect(first.data).toMatchObject({ ok: true, outcome, idempotent: false });
      const again = await rpc(cashier, a);
      expect(again.data).toMatchObject({ ok: true, outcome, idempotent: true, auditId: first.data.auditId });
      const rows = await rowsFor(sale);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe(action);
    }
    const sale = newSale();
    const k = key();
    const tab = await seedTab(k);
    const t = await ticket(cashier, manager);
    const a = args({ p_intent: 'review', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_idempotency_key: k, p_reason: null });
    const first = await rpc(cashier, a);
    expect(first.data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: tab, idempotent: false });
    const again = await rpc(cashier, a);
    expect(again.data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: tab, idempotent: true });
    const rows = await rowsFor(sale);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('offline_sale.linked');
  });

  it('two simultaneous write-offs with one ticket both answer written_off', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const a = args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id });
    const [r1, r2] = await Promise.all([rpc(cashier, a), rpc(cashier, a)]);
    expect(r1.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect(r2.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect([r1.data.idempotent, r2.data.idempotent].sort()).toEqual([false, true]);
    expect(await rowsFor(sale)).toHaveLength(1);
  });

  it('with two tickets they leave one row and one spent ticket', async () => {
    const sale = newSale();
    const t1 = await ticket(cashier, manager);
    const t2 = await ticket(cashier, manager);
    const [r1, r2] = await Promise.all([
      rpc(cashier, args({ p_sale_id: sale, p_approval_id: t1, p_approver_id: manager.id })),
      rpc(cashier, args({ p_sale_id: sale, p_approval_id: t2, p_approver_id: manager.id })),
    ]);
    expect(r1.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect(r2.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect(await rowsFor(sale)).toHaveLength(1);
    const spent = [(await ticketRow(t1)).consumed_at, (await ticketRow(t2)).consumed_at].filter((x) => x !== null);
    expect(spent).toHaveLength(1);
  });

  it('a sale the server holds under its key is already_recorded and not written off', async () => {
    const sale = newSale();
    const k = key();
    const tab = await seedTab(k);
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_idempotency_key: k, p_recorded_tab_id: tab, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: tab });
    const rows = await rowsFor(sale);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'offline_sale.linked' });
    expect(rows[0].after.linkedTabId).toBe(tab);
  });

  it('a split sale is found under the -leg0 key', async () => {
    const sale = newSale();
    const k = key();
    const tab = await seedTab(k, { legs: true });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: tab });
    expect((await rowsFor(sale))[0].action).toBe('offline_sale.linked');
  });

  it('a payment by another cashier or on another tab is a mismatch: write-off records it, rering and review raise SERVER_MISMATCH and spend nothing', async () => {
    const k = key();
    const tab = await seedTab(k, { seller: cashier2 });
    // write-off: recorded as written_off carrying the mismatch kind.
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const wo = await rpc(cashier, args({ p_sale_id: sale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(wo.data).toMatchObject({ ok: true, outcome: 'written_off' });
    const rows = await rowsFor(sale);
    expect(rows[0].action).toBe('offline_sale.written_off');
    expect(rows[0].after.serverCheck).toMatchObject({ kind: 'cashier', tabId: tab });
    // rering / review: raise, ticket kept.
    for (const intent of ['rering', 'review']) {
      const s = newSale();
      const tk = await ticket(cashier, manager);
      const r = await rpc(cashier, args({ p_intent: intent, p_sale_id: s, p_idempotency_key: k, p_approval_id: tk, p_approver_id: manager.id, p_reason: null }));
      expect(r.error?.message).toContain('SERVER_MISMATCH');
      expect(await rowsFor(s)).toHaveLength(0);
      expect((await ticketRow(tk)).consumed_at).toBeNull();
    }
    // another tab: the till recorded a different tab than the one the payment is on.
    const k2 = key();
    await seedTab(k2);
    const s2 = newSale();
    const tk2 = await ticket(cashier, manager);
    const r2 = await rpc(cashier, args({ p_intent: 'review', p_sale_id: s2, p_idempotency_key: k2, p_recorded_tab_id: randomUUID(), p_approval_id: tk2, p_approver_id: manager.id, p_reason: null }));
    expect(r2.error?.message).toContain('SERVER_MISMATCH');
    expect((await ticketRow(tk2)).consumed_at).toBeNull();
  });

  it('a held payment with different goods is a mismatch', async () => {
    const k = key();
    await seedTab(k, { lines: [{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }] });
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect((await rowsFor(sale))[0].after.serverCheck.kind).toBe('goods');
  });

  it('after a rering approval a paid re-ring is linked whether or not its canonical key is also passed in p_rering_keys', async () => {
    for (const via of ['attempt', 'prefix'] as const) {
      const sale = newSale();
      const a1 = await ticket(cashier, manager);
      const approved = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
      expect(approved.data.outcome).toBe('proceed');
      const attemptKey = `rering_${sale}_${Date.now()}_${via}`;
      const tab = await seedTab(attemptKey, { processedAt: new Date(Date.now() + 1000).toISOString() });
      const t = await ticket(cashier, manager);
      const { data } = await rpc(cashier, args({
        p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_idempotency_key: key(), p_rering_keys: via === 'attempt' ? [attemptKey] : [],
      }));
      expect(data).toMatchObject({ ok: true, outcome: 'already_rerung', tabId: tab });
    }
  });

  it('a rering_-prefixed payment with no rering_approved row is not a twin', async () => {
    const sale = newSale();
    await seedTab(`rering_${sale}_${Date.now()}_abc`);
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect((await rowsFor(sale))[0].after.serverCheck.kind).toBe('attempt');
  });

  it('a payment made before the approval is not linked', async () => {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    const early = `rering_${sale}_${Date.now()}_early`;
    await seedTab(early, { processedAt: new Date(Date.now() - 3600_000).toISOString() });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_rering_keys: [early] }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
    const rows = await rowsFor(sale);
    expect(rows.at(-1).after.serverCheck.kind).toBe('attempt');
  });

  it('re-ring is refused, not approved, when a payment under one of its keys is not provably this sale', async () => {
    const otherGoods = [{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }];
    const refuse = async (sale: string, rering: string[], expectedRows: number) => {
      const t = await ticket(cashier, manager);
      const r = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_rering_keys: rering, p_reason: null }));
      expect(r.error?.message).toContain('SERVER_MISMATCH');
      expect(await rowsFor(sale)).toHaveLength(expectedRows);
      expect((await ticketRow(t)).consumed_at).toBeNull();
    };

    // no rering_approved row yet: a payment under an attempt key, or under the rering_<sale>_ prefix, is nobody's twin
    const unapprovedAttempt = newSale();
    const attemptKey = `rering_${unapprovedAttempt}_${Date.now()}_att`;
    await seedTab(attemptKey, { processedAt: new Date(Date.now() + 1000).toISOString() });
    await refuse(unapprovedAttempt, [attemptKey], 0);

    const unapprovedPrefix = newSale();
    await seedTab(`rering_${unapprovedPrefix}_${Date.now()}_abc`, { processedAt: new Date(Date.now() + 1000).toISOString() });
    await refuse(unapprovedPrefix, [], 0);

    // approved, but the payment is older than the approval, or rang other goods
    const approved = newSale();
    const a1 = await ticket(cashier, manager);
    const granted = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: approved, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    expect(granted.data.outcome).toBe('proceed');
    const early = `rering_${approved}_${Date.now()}_early`;
    await seedTab(early, { processedAt: new Date(Date.now() - 3600_000).toISOString() });
    const other = `rering_${approved}_${Date.now()}_def`;
    await seedTab(other, { processedAt: new Date(Date.now() + 1000).toISOString(), lines: otherGoods });
    await refuse(approved, [early], 1);
    await refuse(approved, [], 1);
  });

  it('one server tab cannot link two offline sales', async () => {
    const k = key();
    const tab = await seedTab(k);
    const s1 = newSale();
    const t1 = await ticket(cashier, manager);
    const first = await rpc(cashier, args({ p_sale_id: s1, p_idempotency_key: k, p_approval_id: t1, p_approver_id: manager.id }));
    expect(first.data).toMatchObject({ outcome: 'already_recorded', tabId: tab });
    // A second offline sale whose key resolves to the same payment.
    const s2 = newSale();
    const t2 = await ticket(cashier, manager);
    const second = await rpc(cashier, args({ p_sale_id: s2, p_idempotency_key: k, p_approval_id: t2, p_approver_id: manager.id }));
    expect(second.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect((await rowsFor(s2))[0].after.serverCheck.kind).toBe('claimed');
  });

  it('two sales racing for one server tab leave exactly one linked row', async () => {
    for (let i = 0; i < 5; i++) {
      const k = key();
      const tab = await seedTab(k);
      const s1 = newSale();
      const s2 = newSale();
      const t1 = await ticket(cashier, manager);
      const t2 = await ticket(cashier, manager);
      const mine = (sale: string, t: string) =>
        rpc(cashier, args({ p_intent: 'review', p_sale_id: sale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
      const [r1, r2] = await Promise.all([mine(s1, t1), mine(s2, t2)]);
      const results = [r1, r2];
      const ok = results.filter((r) => r.data?.ok === true);
      const refused = results.filter((r) => String(r.error?.message ?? '').includes('SERVER_MISMATCH'));
      expect(ok, `iteration ${i}`).toHaveLength(1);
      expect(refused, `iteration ${i}`).toHaveLength(1);
      const { data: linked } = await db.from('audit_logs').select('entity_id').eq('action', 'offline_sale.linked').in('entity_id', [s1, s2]);
      expect(linked, `iteration ${i}`).toHaveLength(1);
      expect(ok[0]!.data.tabId).toBe(tab);
    }
  });

  it('a signed-in cashier cannot execute offline_sale_stored_outcome', async () => {
    const { error } = await cashier.client.rpc('offline_sale_stored_outcome', { p_sale_id: randomUUID(), p_actor: cashier.id, p_approval_id: null, p_any_written_off: true });
    expect(error?.code).toBe('42501');
  });

  it('a signed-in cashier cannot execute offline_sale_goods_match', async () => {
    const { error } = await cashier.client.rpc('offline_sale_goods_match', { p_tab_id: randomUUID(), p_lines: [lineA()] });
    expect(error?.code).toBe('42501');
  });

  const untrustedClaim = { receiptNumber: 'R-U', total: 20, soldAt: new Date().toISOString(), terminalId: 'POS-T', lastCode: 'X', keyUntrusted: true };

  it('a held link answers with the server amount', async () => {
    const k = key();
    await seedTab(k);
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: newSale(), p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', serverAmount: 20 });
  });

  it('a twin link answers with the server amount', async () => {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    await seedTab(`rering_${sale}_${Date.now()}_amt`, { processedAt: new Date(Date.now() + 1000).toISOString() });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_rerung', serverAmount: 20 });
  });

  it('a split server sale answers with the sum of its legs', async () => {
    const k = key();
    await seedTab(k, { legs: true });
    const { data: leg0 } = await db.from('payments').select('tab_id').eq('idempotency_key', `${k}-leg0`).single();
    expect((await db.from('payments').insert({ tab_id: leg0.tab_id, amount: 7.5, method: 'cash', processed_by: cashier.id, idempotency_key: `${k}-leg1` })).error).toBeNull();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: newSale(), p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', serverAmount: 27.5 });
  });

  it('an idempotent replay answers with the same server amount', async () => {
    const k = key();
    await seedTab(k);
    const t = await ticket(cashier, manager);
    const a = args({ p_sale_id: newSale(), p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id });
    const first = await rpc(cashier, a);
    const again = await rpc(cashier, a);
    expect(first.data.serverAmount).toBe(20);
    expect(again.data).toMatchObject({ idempotent: true, serverAmount: 20 });
  });

  /** A sale with an approved re-ring (approval row written now) and a re-ring-keyed payment 1 s after it. */
  async function paidRering(lines?: Line[]): Promise<{ sale: string; tab: string }> {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    const tab = await seedTab(`rering_${sale}_${Date.now()}_p`, { processedAt: new Date(Date.now() + 1000).toISOString(), ...(lines ? { lines } : {}) });
    return { sale, tab };
  }

  /** A write-off over a paid re-ring LINKS it: already_rerung, ticket spent, a linked row with linkOverride and amountShort, no written_off row. */
  async function expectPaidReringLink(p: { sale: string; tab: string }, over: Record<string, unknown>, kind: string, net = { serverAmount: 20, amountShort: 0 }): Promise<{ t: string; data: any }> {
    const t = await ticket(cashier, manager);
    const { data, error } = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id, ...over }));
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, outcome: 'already_rerung', tabId: p.tab, ...net, idempotent: false });
    const rows = (await rowsFor(p.sale)).filter((x) => x.action !== 'offline_sale.rering_approved');
    expect(rows.map((x) => x.action)).toEqual(['offline_sale.linked']);
    expect(rows[0].after).toMatchObject({ outcome: 'already_rerung', linkedTabId: p.tab, linkOverride: true, amountShort: net.amountShort, serverCheck: { kind } });
    expect(rows[0].after).not.toHaveProperty('goodsDiffer');
    expect((await ticketRow(t)).consumed_at).not.toBeNull();
    return { t, data };
  }

  async function expectPaidReringRefusal(sale: string, over: Record<string, unknown>, code = 'RERING_ALREADY_PAID'): Promise<string> {
    const t = await ticket(cashier, manager);
    const { data, error } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, ...over }));
    expect(data).toBeNull();
    expect(error?.message).toContain(code);
    expect((await rowsFor(sale)).filter((x) => x.action !== 'offline_sale.rering_approved')).toHaveLength(0);
    expect((await ticketRow(t)).consumed_at).toBeNull();
    return t;
  }

  it('a write-off over a paid re-ring with different goods links it with linkOverride, spends the ticket and writes no write-off', async () => {
    const p = await paidRering([{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }]);
    await expectPaidReringLink(p, {}, 'attempt');
  });

  it('a repeated write-off over a paid re-ring answers the stored link and writes no second row', async () => {
    const p = await paidRering([{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }]);
    const { t, data } = await expectPaidReringLink(p, {}, 'attempt');
    const again = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(again.data).toMatchObject({ ok: true, outcome: 'already_rerung', tabId: p.tab, idempotent: true, auditId: data.auditId });
    expect((await rowsFor(p.sale)).filter((x) => x.action === 'offline_sale.linked')).toHaveLength(1);
  });

  it('an untrusted write-off over a paid re-ring links it too', async () => {
    const p = await paidRering();
    await expectPaidReringLink(p, { p_idempotency_key: null, p_claim: untrustedClaim }, 'none');
  });

  it('several paid re-rings: the earliest after the approval is linked', async () => {
    const other: Line[] = [{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }];
    const p = await paidRering(other);
    await seedTab(`rering_${p.sale}_${Date.now()}_later`, { processedAt: new Date(Date.now() + 5000).toISOString(), lines: other });
    await expectPaidReringLink(p, {}, 'attempt');
    expect((await rowsFor(p.sale)).find((x) => x.action === 'offline_sale.linked').after.paidReringCount).toBe(2);
  });

  it('a paid re-ring whose tab is already linked to another offline sale still raises RERING_ALREADY_PAID, and the same ticket then serves an allowed intent', async () => {
    const p = await paidRering();
    const other = newSale();
    expect((await db.from('audit_logs').insert({ actor_id: cashier.id, action: 'offline_sale.linked', entity_type: 'offline_sale', entity_id: other, source: 'rpc', after: { linkedTabId: p.tab } })).error).toBeNull();
    const t = await expectPaidReringRefusal(p.sale, {});
    // M-T2-2: the refusal spent nothing, so the very same ticket still moves the sale to review.
    const { data } = await rpc(cashier, args({ p_intent: 'review', p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null, p_idempotency_key: null, p_claim: untrustedClaim }));
    expect(data).toMatchObject({ ok: true, outcome: 'moved_to_review' });
    expect((await ticketRow(t)).consumed_at).not.toBeNull();
  });

  /** The server holds the original under its own key beside a counted paid re-ring: the ORIGINAL tab is linked, nothing proceeds. */
  async function expectOriginalLink(p: { sale: string; tab: string }, orig: string, over: Record<string, unknown>, kind: string): Promise<{ t: string; data: any }> {
    const t = await ticket(cashier, manager);
    const { data, error } = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id, ...over }));
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: orig, duplicateReringTabId: p.tab, idempotent: false });
    const rows = (await rowsFor(p.sale)).filter((x) => x.action !== 'offline_sale.rering_approved');
    expect(rows.map((x) => x.action)).toEqual(['offline_sale.linked']);
    expect(rows[0].after).toMatchObject({ outcome: 'already_recorded', linkedTabId: orig, linkOverride: true, duplicateReringTabId: p.tab, serverCheck: { kind } });
    expect((await ticketRow(t)).consumed_at).not.toBeNull();
    const again = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id, ...over }));
    expect(again.data).toMatchObject({ outcome: 'already_recorded', tabId: orig, duplicateReringTabId: p.tab, idempotent: true, auditId: data.auditId });
    return { t, data };
  }

  it('a held payment links the original (linkOverride, duplicateReringTabId) when a paid re-ring also exists', async () => {
    const p = await paidRering();
    const k = key();
    const heldTab = await seedTab(k);
    const { t, data } = await expectOriginalLink(p, heldTab, { p_idempotency_key: k }, 'held');
    const again = await rpc(cashier, args({ p_sale_id: p.sale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(again.data).toMatchObject({ outcome: 'already_recorded', tabId: heldTab, duplicateReringTabId: p.tab, idempotent: true, auditId: data.auditId });
  });

  it('the rering intent on a held payment with a paid re-ring links the original and does not proceed', async () => {
    const p = await paidRering();
    const k = key();
    const heldTab = await seedTab(k);
    await expectOriginalLink(p, heldTab, { p_intent: 'rering', p_idempotency_key: k, p_reason: null }, 'held');
  });

  it('a re-ring-keyed payment made before the approval, or with no approval row, does not block a write-off', async () => {
    const early = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: early, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    await seedTab(`rering_${early}_${Date.now()}_e`, { processedAt: new Date(Date.now() - 3600_000).toISOString() });
    const noApproval = newSale();
    await seedTab(`rering_${noApproval}_${Date.now()}_n`);
    for (const sale of [early, noApproval]) {
      const t = await ticket(cashier, manager);
      const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_idempotency_key: null, p_claim: untrustedClaim }));
      expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
    }
  });

  it('a paid direct_sale_ key passed in p_rering_keys is not linked and does not count as a paid re-ring', async () => {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    const ordinary = `direct_sale_${randomUUID()}`;
    await seedTab(ordinary, { processedAt: new Date(Date.now() + 1000).toISOString() });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_rering_keys: [ordinary] }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect(data.tabId).toBeUndefined();
    expect((await rowsFor(sale)).at(-1).after.serverCheck.kind).toBe('none');
  });

  it('a paid re-ring beside an original already paid on the server (cashier / tab / goods) links the original and spends the ticket', async () => {
    const k = key();
    const t1 = await seedTab(k, { seller: cashier2 });
    await expectOriginalLink(await paidRering(), t1, { p_idempotency_key: k }, 'cashier');
    const kt = key();
    const t2 = await seedTab(kt);
    await expectOriginalLink(await paidRering(), t2, { p_idempotency_key: kt, p_recorded_tab_id: randomUUID() }, 'tab');
    const kg = key();
    const t3 = await seedTab(kg, { lines: [{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }] });
    await expectOriginalLink(await paidRering(), t3, { p_idempotency_key: kg }, 'goods');
  });

  it('once the duplicate re-ring is fully refunded the rering intent answers SERVER_MISMATCH and the write-off goes through', async () => {
    const p = await paidRering();
    const k = key();
    await seedTab(k, { seller: cashier2 });
    expect((await db.from('payments').insert({ tab_id: p.tab, amount: -20, method: 'cash', processed_by: manager.id, is_refund: true, idempotency_key: `refund-${randomUUID()}` })).error).toBeNull();
    // M8: pinned current behaviour, the original is held by another cashier so a re-ring is refused.
    const tr = await ticket(cashier, manager);
    const mismatch = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: p.sale, p_approval_id: tr, p_approver_id: manager.id, p_idempotency_key: k, p_reason: null }));
    expect(mismatch.data).toBeNull();
    expect(mismatch.error?.message).toContain('SERVER_MISMATCH');
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id, p_idempotency_key: k }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
  });

  it('a partly refunded re-ring still counts', async () => {
    const p = await paidRering([{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }]);
    expect((await db.from('payments').insert({ tab_id: p.tab, amount: -5, method: 'cash', processed_by: manager.id, is_refund: true, idempotency_key: `refund-${randomUUID()}` })).error).toBeNull();
    // net of the refund: the server holds 15 of the claimed 20
    await expectPaidReringLink(p, {}, 'attempt', { serverAmount: 15, amountShort: 5 });
  });

  it('a reopened, still-open re-ring tab counts: the write-off links it instead of writing off', async () => {
    const p = await paidRering([{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }]);
    expect((await db.from('payments').update({ status: 'reopened_void' }).eq('tab_id', p.tab)).error).toBeNull();
    const { data: tab } = await db.from('tabs').select('version').eq('id', p.tab).single();
    expect((await db.from('tabs').update({ status: 'open', closed_at: null, version: tab.version + 1 }).eq('id', p.tab)).error).toBeNull();
    // nothing is net-paid yet, so the whole claim is short
    await expectPaidReringLink(p, {}, 'attempt', { serverAmount: 0, amountShort: 20 });
  });

  it('a soft-deleted reopened-open re-ring tab does not count: the write-off goes through', async () => {
    const p = await paidRering([{ product_id: productB, quantity: 2, modifier_ids: [], weight_grams: null }]);
    expect((await db.from('payments').update({ status: 'reopened_void' }).eq('tab_id', p.tab)).error).toBeNull();
    const { data: tab } = await db.from('tabs').select('version').eq('id', p.tab).single();
    expect((await db.from('tabs').update({ status: 'open', closed_at: null, is_deleted: true, version: tab.version + 1 }).eq('id', p.tab)).error).toBeNull();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: p.sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
  });

  it('a recorded tab with no payment under the sale own key links the paid re-ring', async () => {
    const p = await paidRering();
    await expectPaidReringLink(p, { p_recorded_tab_id: randomUUID() }, 'tab');
  });

  it('a re-ring rung by a different staff than the approver is not counted: the write-off goes through', async () => {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    await seedTab(`rering_${sale}_${Date.now()}_other`, { seller: cashier2, processedAt: new Date(Date.now() + 1000).toISOString() });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'written_off' });
  });

  it('a claimed original with a paid re-ring raises RERING_ALREADY_PAID for write_off and rering, and spends nothing', async () => {
    const p = await paidRering();
    const k = key();
    const heldTab = await seedTab(k);
    expect((await db.from('audit_logs').insert({ actor_id: cashier.id, action: 'offline_sale.linked', entity_type: 'offline_sale', entity_id: newSale(), source: 'rpc', after: { linkedTabId: heldTab } })).error).toBeNull();
    await expectPaidReringRefusal(p.sale, { p_idempotency_key: k });
    await expectPaidReringRefusal(p.sale, { p_intent: 'rering', p_idempotency_key: k, p_reason: null });
  });

  it('amountShort never exceeds the claimed total when a partly refunded tab nets negative', async () => {
    const k = key();
    const tab = await seedTab(k);
    expect((await db.from('payments').insert({ tab_id: tab, amount: -30, method: 'cash', processed_by: manager.id, is_refund: true, idempotency_key: `refund-${randomUUID()}` })).error).toBeNull();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: newSale(), p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_recorded', serverAmount: -10, amountShort: 20 });
  });

  it('a link reports amountShort: 0 when the server covers the claim, the shortfall when it does not', async () => {
    const k = key();
    await seedTab(k);
    const t = await ticket(cashier, manager);
    const shortSale = newSale();
    const short = await rpc(cashier, args({ p_sale_id: shortSale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id, p_claim: { receiptNumber: 'R-S', total: 30, soldAt: new Date().toISOString(), terminalId: 'POS-T', lastCode: 'X', keyUntrusted: false } }));
    expect(short.data).toMatchObject({ ok: true, outcome: 'already_recorded', serverAmount: 20, amountShort: 10 });
    const k2 = key();
    await seedTab(k2);
    const again = await rpc(cashier, args({ p_sale_id: newSale(), p_idempotency_key: k2, p_approval_id: await ticket(cashier, manager), p_approver_id: manager.id }));
    expect(again.data).toMatchObject({ ok: true, serverAmount: 20, amountShort: 0 });
    const replay = await rpc(cashier, args({ p_sale_id: shortSale, p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
    expect(replay.data).toMatchObject({ idempotent: true, amountShort: 10 });
  });

  it('an untrusted record is never linked', async () => {
    const k = key();
    await seedTab(k);
    for (const intent of ['write_off', 'review']) {
      const sale = newSale();
      const t = await ticket(cashier, manager);
      const { data } = await rpc(cashier, args({ p_intent: intent, p_sale_id: sale, p_idempotency_key: k, p_claim: untrustedClaim, p_approval_id: t, p_approver_id: manager.id, p_reason: intent === 'review' ? null : REASON }));
      expect(data).toMatchObject({ ok: true, outcome: intent === 'review' ? 'moved_to_review' : 'written_off' });
      expect(data.tabId).toBeUndefined();
      expect((await rowsFor(sale)).some((r) => r.action === 'offline_sale.linked')).toBe(false);
    }
  });

  it('a written-off sale cannot be approved for re-ring', async () => {
    const sale = newSale();
    const w = await ticket(cashier, manager);
    await rpc(cashier, args({ p_sale_id: sale, p_approval_id: w, p_approver_id: manager.id }));
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    expect(data).toEqual({ ok: false, code: 'ALREADY_WRITTEN_OFF' });
    expect((await rowsFor(sale)).map((r) => r.action)).toEqual(['offline_sale.written_off']);
  });

  it('a write-off and a re-ring for the same sale at the same moment do not both commit', async () => {
    // Method: a psql session (dev2 Postgres only) plays the write-off. It takes the per-sale lock, holds
    // it 2 s, inserts the written_off row and commits; the re-ring is fired while it holds the lock.
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const script = [
      'BEGIN;',
      `SELECT pg_advisory_xact_lock(hashtextextended('${sale}', 1));`,
      "SELECT 'LOCKED';",
      'SELECT pg_sleep(2);',
      `INSERT INTO public.audit_logs (action, entity_type, entity_id, source, after) VALUES ('offline_sale.written_off', 'offline_sale', '${sale}', 'rpc', '{}'::jsonb);`,
      'COMMIT;',
    ].join(String.fromCharCode(10));
    const child = spawn('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', 'postgresql://postgres@127.0.0.1:56322/postgres?sslmode=disable'], {
      env: { ...process.env, PGPASSWORD: 'postgres' },
    });
    let out = '';
    const locked = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('LOCKED')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (c) => reject(new Error(`psql exited ${c} before locking`)));
    });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.stdin.end(script);
    await locked.catch(() => undefined);
    const { data } = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    await exited;
    expect(data).toEqual({ ok: false, code: 'ALREADY_WRITTEN_OFF' });
    expect((await rowsFor(sale)).map((r) => r.action)).toEqual(['offline_sale.written_off']);
  }, 30_000);

  it('a written-off sale cannot be moved to review', async () => {
    const sale = newSale();
    const w = await ticket(cashier, manager);
    await rpc(cashier, args({ p_sale_id: sale, p_approval_id: w, p_approver_id: manager.id }));
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_intent: 'review', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    expect(data).toEqual({ ok: false, code: 'ALREADY_WRITTEN_OFF' });
    expect((await rowsFor(sale)).map((r) => r.action)).toEqual(['offline_sale.written_off']);
  });

  it('a refused intent on a written-off sale leaves the ticket unspent', async () => {
    const sale = newSale();
    const w = await ticket(cashier, manager);
    await rpc(cashier, args({ p_sale_id: sale, p_approval_id: w, p_approver_id: manager.id }));
    const t = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'review', p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    expect((await ticketRow(t)).consumed_at).toBeNull();
  });

  it('an explicit keyUntrusted false with no key is treated as untrusted', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_idempotency_key: null, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    expect(data).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await rowsFor(sale)).toHaveLength(0);
  });

  it('an untrusted record cannot be approved for re-ring', async () => {
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_idempotency_key: null, p_claim: untrustedClaim, p_approval_id: t, p_approver_id: manager.id, p_reason: null }));
    expect(data).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await rowsFor(sale)).toHaveLength(0);
    expect((await ticketRow(t)).consumed_at).toBeNull();
  });

  it('a recorded tab with no payment on the server is a tab mismatch', async () => {
    const ghostTab = randomUUID();
    const sale = newSale();
    const t = await ticket(cashier, manager);
    const wo = await rpc(cashier, args({ p_sale_id: sale, p_idempotency_key: key(), p_recorded_tab_id: ghostTab, p_approval_id: t, p_approver_id: manager.id }));
    expect(wo.data).toMatchObject({ ok: true, outcome: 'written_off' });
    expect(wo.data.tabId).toBeUndefined();
    const rows = await rowsFor(sale);
    expect(rows.map((r) => r.action)).toEqual(['offline_sale.written_off']);
    expect(rows[0].after.serverCheck.kind).toBe('tab');
    expect((await ticketRow(t)).consumed_at).not.toBeNull();
    for (const intent of ['rering', 'review']) {
      const s = newSale();
      const tk = await ticket(cashier, manager);
      const r = await rpc(cashier, args({ p_intent: intent, p_sale_id: s, p_idempotency_key: key(), p_recorded_tab_id: ghostTab, p_approval_id: tk, p_approver_id: manager.id, p_reason: null }));
      expect(r.error?.message).toContain('SERVER_MISMATCH');
      expect(await rowsFor(s)).toHaveLength(0);
      expect((await ticketRow(tk)).consumed_at).toBeNull();
    }
  });

  it('a combo re-ring whose order rows were split still tallies as the same goods', async () => {
    const sale = newSale();
    const a1 = await ticket(cashier, manager);
    await rpc(cashier, args({ p_intent: 'rering', p_sale_id: sale, p_approval_id: a1, p_approver_id: manager.id, p_reason: null }));
    const lines: Line[] = [{ product_id: productA, quantity: 3, modifier_ids: [], weight_grams: null }];
    const twinKey = `rering_${sale}_${Date.now()}_split`;
    const tab = await seedTab(twinKey, { lines, splitOrderRows: true, processedAt: new Date(Date.now() + 1000).toISOString() });
    const t = await ticket(cashier, manager);
    const { data } = await rpc(cashier, args({ p_sale_id: sale, p_approval_id: t, p_approver_id: manager.id, p_lines: lines }));
    expect(data).toMatchObject({ ok: true, outcome: 'already_rerung', tabId: tab });
  });

  it('a cashier session with a manager ticket gets the same answers after close_tab and view_all_tabs are removed from cashier', async () => {
    await withMatrix([{ role: 'cashier', action: 'close_tab' }, { role: 'cashier', action: 'view_all_tabs' }], 'strip', async () => {
      const k = key();
      const tab = await seedTab(k);
      const t = await ticket(cashier, manager);
      const held = await rpc(cashier, args({ p_sale_id: newSale(), p_idempotency_key: k, p_approval_id: t, p_approver_id: manager.id }));
      expect(held.data).toMatchObject({ ok: true, outcome: 'already_recorded', tabId: tab });
      const t2 = await ticket(cashier, manager);
      const none = await rpc(cashier, args({ p_sale_id: newSale(), p_approval_id: t2, p_approver_id: manager.id }));
      expect(none.data).toMatchObject({ ok: true, outcome: 'written_off' });
    });
    const { data } = await db.from('role_permissions').select('action').eq('role', 'cashier').in('action', ['close_tab', 'view_all_tabs']);
    expect((data ?? []).length).toBe(2);
  });

  it('anon cannot execute; an inactive caller is FORBIDDEN; a short reason, 201 lines, 21 keys or an oversized claim is VALIDATION_ERROR', async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
    const denied = await anon.rpc(ACTION, args({ p_sale_id: randomUUID(), p_approval_id: null }));
    expect(denied.error?.code).toBe('42501');

    const t = await ticket(cashier, manager);
    const base = { p_sale_id: newSale(), p_approval_id: t, p_approver_id: manager.id };
    const cases: Record<string, Record<string, unknown>> = {
      'short reason': { p_reason: 'too short' },
      'bad intent': { p_intent: 'delete' },
      '201 lines': { p_lines: Array.from({ length: 201 }, () => lineA(1)) },
      'no lines': { p_lines: [] },
      '21 keys': { p_rering_keys: Array.from({ length: 21 }, () => key()) },
      'big claim': { p_claim: { receiptNumber: 'x'.repeat(5000) } },
    };
    for (const [name, over] of Object.entries(cases)) {
      const { data } = await rpc(cashier, args({ ...base, ...over }));
      expect(data, name).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    }
    expect((await ticketRow(t)).consumed_at).toBeNull();

    try {
      expect((await db.from('profiles').update({ is_active: false }).eq('id', cashier2.id)).error).toBeNull();
      const { error } = await rpc(cashier2, args({ p_sale_id: newSale(), p_approval_id: t, p_approver_id: manager.id }));
      expect(error?.message).toContain('FORBIDDEN');
    } finally {
      await db.from('profiles').update({ is_active: true }).eq('id', cashier2.id);
    }
  });

  it('review and rering write offline_sale.escalated and offline_sale.rering_approved', async () => {
    const s1 = newSale();
    const t1 = await ticket(cashier, manager);
    const review = await rpc(cashier, args({ p_intent: 'review', p_sale_id: s1, p_approval_id: t1, p_approver_id: manager.id, p_reason: null }));
    expect(review.data).toMatchObject({ ok: true, outcome: 'moved_to_review' });
    expect((await rowsFor(s1))[0].action).toBe('offline_sale.escalated');
    const s2 = newSale();
    const t2 = await ticket(cashier, manager);
    const rering = await rpc(cashier, args({ p_intent: 'rering', p_sale_id: s2, p_approval_id: t2, p_approver_id: manager.id, p_reason: null }));
    expect(rering.data).toMatchObject({ ok: true, outcome: 'proceed' });
    expect((await rowsFor(s2))[0].action).toBe('offline_sale.rering_approved');
  });
});

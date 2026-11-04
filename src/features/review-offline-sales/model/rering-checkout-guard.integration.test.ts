/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';

/**
 * Integration test: process_direct_sale_atomic re-ring guard (two-mode Plan 02d, Task 1, change C1).
 * A payment under a rering_<sale id>_ key needs a server rering_approved row and no written_off row.
 * Users/sign-in/tickets follow resolve-offline-sale-rpc.integration.test.ts. Target: dev2 only.
 *
 * Run: npx vitest run --project integration src/features/review-offline-sales/model/rering-checkout-guard.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__rering_checkout_guard_test__';

interface TestUser {
  id: string;
  name: string;
  email: string;
  role: 'manager' | 'cashier';
  pin: string;
  client: any;
}

describe.skipIf(skip)('process_direct_sale_atomic re-ring guard', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const mk = (tag: string, role: TestUser['role']): TestUser => ({ id: '', name: `${TAG}${tag}`, email: `${TAG}${tag}_${stamp}@test.local`, role, pin: '', client: null });
  const cashier = mk('c', 'cashier');
  const manager = mk('m', 'manager');
  const users = [cashier, manager];
  const saleIds: string[] = [];
  const keys: string[] = [];
  let shiftId = '';
  let cajaId = '';
  let categoryId = '';
  let productId = '';

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
    const { error: profileErr } = await db.from('profiles').upsert({ id: u.id, name: u.name, email: u.email, role: u.role, pin: u.pin, is_active: true });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    // Password sign-in straight against auth (the derived password), so the test needs no edge function.
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: signErr } = await u.client.auth.signInWithPassword({ email: u.email, password: await deriveStaffPassword(newId, u.pin) });
    if (signErr) throw new Error(`sign in for ${u.name}: ${signErr.message}`);
  }

  async function ticket(action: string): Promise<string> {
    const { data, error } = await cashier.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: manager.id, p_required_action: action });
    expect(error).toBeNull();
    expect(data.ok, JSON.stringify(data)).toBe(true);
    return data.approval_id as string;
  }
  const consumed = async (id: string): Promise<string | null> => (await db.from('manager_approvals').select('consumed_at').eq('id', id).single()).data.consumed_at;

  const newSale = (): string => {
    const id = randomUUID();
    saleIds.push(id);
    return id;
  };
  const rkey = (sale: string): string => {
    const k = `rering_${sale}_${randomUUID()}`;
    keys.push(k);
    return k;
  };
  async function audit(sale: string, action: string, actorId: string = cashier.id): Promise<void> {
    const { error } = await db.from('audit_logs').insert({ actor_id: actorId, action, entity_type: 'offline_sale', entity_id: sale, source: 'rpc' });
    expect(error).toBeNull();
  }

  async function checkout(idempotencyKey: string, over: Record<string, unknown> = {}): Promise<any> {
    if (!keys.includes(idempotencyKey)) keys.push(idempotencyKey);
    const { data, error } = await db.rpc('process_direct_sale_atomic', {
      p_staff_id: cashier.id,
      p_shift_id: shiftId,
      p_caja_session_id: cajaId,
      p_items: [{ product_id: productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' }],
      p_idempotency_key: idempotencyKey,
      p_method: 'cash',
      p_amount: 10,
      p_tendered_amount: 10,
      p_manager_override: false,
      ...over,
    });
    expect(error).toBeNull();
    return data;
  }
  async function paymentsFor(k: string): Promise<any[]> {
    return (await db.from('payments').select('id, tab_id').like('idempotency_key', `${k}%`)).data ?? [];
  }
  async function movementCount(): Promise<number> {
    return ((await db.from('stock_movements').select('id').eq('product_id', productId)).data ?? []).length;
  }
  const tabCount = async (): Promise<number> => ((await db.from('tabs').select('id').eq('shift_id', shiftId)).data ?? []).length;
  const promoAuditCount = async (): Promise<number> => ((await db.from('audit_logs').select('id').eq('action', 'promotion.apply')).data ?? []).length;
  const auditRows = async (sale: string, action: string): Promise<number> =>
    ((await db.from('audit_logs').select('id').eq('entity_type', 'offline_sale').eq('entity_id', sale).eq('action', action)).data ?? []).length;

  /** A second Postgres session (psql, dev2 only) takes the per-sale lock the RPCs serialise on, holds it
   *  `holdMs`, optionally writes the write-off row, then commits. Resolves once the lock is held. */
  async function holdSaleLock(sale: string, holdMs: number, writeOff: boolean): Promise<{ released: Promise<void> }> {
    const script = [
      'BEGIN;',
      `SELECT pg_advisory_xact_lock(hashtextextended('${sale}', 1));`,
      "SELECT 'LOCKED';",
      `SELECT pg_sleep(${holdMs / 1000});`,
      writeOff ? `INSERT INTO public.audit_logs (action, entity_type, entity_id, source, after) VALUES ('offline_sale.written_off', 'offline_sale', '${sale}', 'rpc', '{}'::jsonb);` : '',
      'COMMIT;',
    ].join(String.fromCharCode(10));
    const child = spawn('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', 'postgresql://postgres@127.0.0.1:56322/postgres?sslmode=disable'], {
      env: { ...process.env, PGPASSWORD: 'postgres' },
    });
    let out = '';
    const released = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const locked = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('LOCKED')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (c) => reject(new Error(`psql exited ${c} before locking`)));
    });
    child.stdin.end(script);
    await locked;
    return { released };
  }
  const writeOffRpc = (sale: string, approvalId: string, quantity = 1): Promise<any> =>
    cashier.client.rpc('resolve_offline_sale', {
      p_sale_id: sale,
      p_intent: 'write_off',
      p_idempotency_key: `${TAG}${randomUUID()}`,
      p_rering_keys: [],
      p_lines: [{ product_id: productId, quantity, modifier_ids: [], weight_grams: null }],
      p_seller_id: cashier.id,
      p_recorded_tab_id: null,
      p_claim: { receiptNumber: 'R-1', total: 10, soldAt: new Date().toISOString(), terminalId: 'POS-T', lastCode: 'X', keyUntrusted: false },
      p_reason: 'race test write-off',
      p_approver_id: manager.id,
      p_approval_id: approvalId,
    });

  beforeAll(async () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
    for (const u of users) await makeUser(u);
    const shift = await db.from('shifts').insert({ staff_id: cashier.id, opening_cash: 0 }).select('id').single();
    if (shift.error) throw new Error(`shift: ${shift.error.message}`);
    shiftId = shift.data.id;
    const caja = await db.from('caja_sessions').insert({ opened_by: cashier.id, opening_cash: 0, terminal_id: `RG-${stamp}` }).select('id').single();
    if (caja.error) throw new Error(`caja: ${caja.error.message}`);
    cajaId = caja.data.id;
    const cat = await db.from('categories').insert({ name: `${TAG}${stamp}` }).select('id').single();
    if (cat.error) throw new Error(`category: ${cat.error.message}`);
    categoryId = cat.data.id;
    const prod = await db.from('products').insert({ name: `${TAG}${stamp}`, category_id: categoryId, base_price: 10, is_active: true, sold_by_weight: false }).select('id').single();
    if (prod.error) throw new Error(`product: ${prod.error.message}`);
    productId = prod.data.id;
    const inv = await db.from('inventory').insert({ product_id: productId, quantity_on_hand: 1_000_000, cost_price: 0 });
    if (inv.error) throw new Error(`inventory: ${inv.error.message}`);
  }, 120_000);

  afterAll(async () => {
    for (const k of keys) {
      for (const p of await paymentsFor(k)) {
        await db.from('payments').delete().eq('id', p.id);
        const orderIds = (await db.from('orders').select('id').eq('tab_id', p.tab_id)).data?.map((o: { id: string }) => o.id) ?? [];
        if (orderIds.length) await db.from('order_items').delete().in('order_id', orderIds);
        await db.from('orders').delete().eq('tab_id', p.tab_id);
        await db.from('tabs').delete().eq('id', p.tab_id);
      }
    }
    if (saleIds.length) await db.from('audit_logs').delete().eq('entity_type', 'offline_sale').in('entity_id', saleIds);
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length) {
      await db.from('audit_logs').delete().in('actor_id', ids);
      await db.from('manager_approvals').delete().in('caller_id', ids);
    }
    if (productId) {
      await db.from('stock_movements').delete().eq('product_id', productId);
      await db.from('inventory').delete().eq('product_id', productId);
      await db.from('products').delete().eq('id', productId);
    }
    if (categoryId) await db.from('categories').delete().eq('id', categoryId);
    if (cajaId) await db.from('caja_sessions').delete().eq('id', cajaId);
    if (shiftId) await db.from('shifts').delete().eq('id', shiftId);
    for (const u of users) {
      if (!u.id) continue;
      await db.from('pin_attempts').delete().like('attempt_key', `%${u.id}%`);
      await db.from('profiles').delete().eq('id', u.id);
      await db.auth.admin.deleteUser(u.id);
    }
  });

  it('a rering_ payment is accepted when the server holds a rering_approved row for that sale', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const k = rkey(sale);
    expect(await checkout(k)).toMatchObject({ ok: true });
    expect(await paymentsFor(k)).toHaveLength(1);
  });

  it('a rering_ payment is refused OFFLINE_SALE_WRITTEN_OFF after a server write-off, and nothing is written', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    await audit(sale, 'offline_sale.written_off');
    const k = rkey(sale);
    const before = await movementCount();
    const tabsBefore = await tabCount();
    const promoBefore = await promoAuditCount();
    expect(await checkout(k)).toMatchObject({ ok: false, code: 'OFFLINE_SALE_WRITTEN_OFF' });
    expect(await paymentsFor(k)).toHaveLength(0);
    expect(await movementCount()).toBe(before);
    expect(await tabCount()).toBe(tabsBefore);
    expect(await promoAuditCount()).toBe(promoBefore);
  });

  it('either refusal leaves a manager override unspent', async () => {
    const written = newSale();
    await audit(written, 'offline_sale.written_off');
    const t1 = await ticket('apply_custom_discount');
    expect(await checkout(rkey(written), { p_manager_override: true, p_approval_id: t1, p_approver_id: manager.id })).toMatchObject({ ok: false, code: 'OFFLINE_SALE_WRITTEN_OFF' });
    expect(await consumed(t1)).toBeNull();
    const t2 = await ticket('apply_custom_discount');
    expect(await checkout(rkey(newSale()), { p_manager_override: true, p_approval_id: t2, p_approver_id: manager.id })).toMatchObject({ ok: false, code: 'RERING_NOT_APPROVED' });
    expect(await consumed(t2)).toBeNull();
  });

  it('a rering_ payment with no rering_approved row is refused RERING_NOT_APPROVED; so is rering_ plus a non-UUID; an ordinary key is untouched', async () => {
    const k1 = rkey(newSale());
    expect(await checkout(k1)).toMatchObject({ ok: false, code: 'RERING_NOT_APPROVED' });
    expect(await paymentsFor(k1)).toHaveLength(0);
    const k2 = `rering_not-a-uuid_${randomUUID()}`;
    expect(await checkout(k2)).toMatchObject({ ok: false, code: 'RERING_NOT_APPROVED' });
    expect(await paymentsFor(k2)).toHaveLength(0);
    const k3 = `direct_sale_${TAG}${randomUUID()}`;
    expect(await checkout(k3)).toMatchObject({ ok: true });
    expect(await paymentsFor(k3)).toHaveLength(1);
  });

  it('an upper-case or otherwise non-canonical sale id in a rering_ key is refused RERING_NOT_APPROVED, with no cast error', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    for (const form of [sale.toUpperCase(), sale.replace(/-/g, ''), `{${sale}}`]) {
      const k = `rering_${form}_${randomUUID()}`;
      expect(await checkout(k)).toMatchObject({ ok: false, code: 'RERING_NOT_APPROVED' });
      expect(await paymentsFor(k)).toHaveLength(0);
    }
  });

  it('race order A: the write-off holds the sale lock and wins, so the re-ring payment is refused and nothing is written', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const k = rkey(sale);
    // A psql session plays the write-off: lock, hold, insert written_off, commit. The payment is fired meanwhile.
    const lock = await holdSaleLock(sale, 2000, true);
    const pay = await checkout(k);
    await lock.released;
    expect(pay).toMatchObject({ ok: false, code: 'OFFLINE_SALE_WRITTEN_OFF' });
    expect(await paymentsFor(k)).toHaveLength(0);
    expect(await auditRows(sale, 'offline_sale.written_off')).toBe(1);
  }, 30_000);

  // Also plan Task 2 test 5 (payment vs write-off race).
  it('race order B: the payment wins the sale lock, so the write-off links the paid re-ring (goodsDiffer) and no written_off row exists', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const k = rkey(sale);
    const t = await ticket('resolve_offline_sale');
    const lock = await holdSaleLock(sale, 2500, false);
    // The payment queues on the held lock first; the write-off is fired once it is waiting, so it queues behind it.
    const payP = checkout(k);
    await new Promise((r) => setTimeout(r, 800));
    // Goods differ from the paid re-ring (qty 2 vs 1): the write-off links it with goodsDiffer, never writes off.
    const woP = writeOffRpc(sale, t, 2);
    const [pay, wo] = await Promise.all([payP, woP]);
    await lock.released;
    expect(pay).toMatchObject({ ok: true });
    expect(wo.data, JSON.stringify(wo)).toMatchObject({ ok: true, outcome: 'already_rerung' });
    expect(await auditRows(sale, 'offline_sale.linked')).toBe(1);
    expect(await paymentsFor(k)).toHaveLength(1);
    expect(await auditRows(sale, 'offline_sale.written_off')).toBe(0);
  }, 30_000);

  it('a real write-off RPC and a rering_ payment fired together never both commit and never deadlock', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const k = rkey(sale);
    const t = await ticket('resolve_offline_sale');
    const [wo, pay] = await Promise.all([writeOffRpc(sale, t), checkout(k)]);
    expect(pay.code, JSON.stringify(pay)).not.toBe('DIRECT_SALE_FAILED');
    const written = await auditRows(sale, 'offline_sale.written_off');
    const paid = (await paymentsFor(k)).length;
    expect(wo.data?.ok, JSON.stringify(wo)).toBe(true);
    if (wo.data.outcome === 'written_off') {
      expect(pay).toMatchObject({ ok: false, code: 'OFFLINE_SALE_WRITTEN_OFF' });
      expect([written, paid]).toEqual([1, 0]);
    } else {
      // Payment won and the matching goods link: the sale is recorded as re-rung, never also written off.
      expect(wo.data.outcome).toBe('already_rerung');
      expect(pay).toMatchObject({ ok: true });
      expect([written, paid]).toEqual([0, 1]);
    }
  });

  it('replaying a paid rering_ key still answers idempotent after the approval exists', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const k = rkey(sale);
    const first = await checkout(k);
    expect(first.ok).toBe(true);
    expect(await checkout(k)).toMatchObject({ ok: true, idempotent: true, tabId: first.tabId });
    expect(await paymentsFor(k)).toHaveLength(1);
  });

  it('a rering_ payment rung by a different staff than the approver is refused RERING_NOT_APPROVED, and nothing is written; that staff then gets its own approval and its re-ring succeeds', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved', manager.id);
    const k = rkey(sale);
    const before = await movementCount();
    expect(await checkout(k)).toMatchObject({ ok: false, code: 'RERING_NOT_APPROVED' });
    expect(await paymentsFor(k)).toHaveLength(0);
    expect(await movementCount()).toBe(before);
    const ok = rkey(sale);
    await audit(sale, 'offline_sale.rering_approved');
    expect(await checkout(ok)).toMatchObject({ ok: true });
    expect(await paymentsFor(ok)).toHaveLength(1);
  });

  it('after a link a further rering_ payment is refused OFFLINE_SALE_ALREADY_CLOSED, and nothing is written', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    await audit(sale, 'offline_sale.linked');
    const k = rkey(sale);
    const before = await movementCount();
    const tabsBefore = await tabCount();
    expect(await checkout(k)).toMatchObject({ ok: false, code: 'OFFLINE_SALE_ALREADY_CLOSED' });
    expect(await paymentsFor(k)).toHaveLength(0);
    expect(await movementCount()).toBe(before);
    expect(await tabCount()).toBe(tabsBefore);
    const t = await ticket('apply_custom_discount');
    expect(await checkout(rkey(sale), { p_manager_override: true, p_approval_id: t, p_approver_id: manager.id })).toMatchObject({ ok: false, code: 'OFFLINE_SALE_ALREADY_CLOSED' });
    expect(await consumed(t)).toBeNull();
  });

  it('a unit product sent with weight_grams = 1 and priced below cost is still refused, and nothing is written', async () => {
    const prod = await db.from('products').insert({ name: `${TAG}unit${stamp}`, category_id: categoryId, base_price: 10, is_active: true, sold_by_weight: false }).select('id').single();
    expect(prod.error).toBeNull();
    const unitId = prod.data.id as string;
    try {
      expect((await db.from('inventory').insert({ product_id: unitId, quantity_on_hand: 1000, cost_price: 20 })).error).toBeNull();
      const k = `direct_sale_${TAG}${randomUUID()}`;
      const r = await checkout(k, {
        p_items: [{ product_id: unitId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '', weight_grams: 1 }],
      });
      expect(r).toMatchObject({ ok: false, code: 'BELOW_COST_REQUIRES_OVERRIDE' });
      expect(await paymentsFor(k)).toHaveLength(0);
      expect((await db.from('stock_movements').select('id').eq('product_id', unitId)).data ?? []).toHaveLength(0);
    } finally {
      await db.from('stock_movements').delete().eq('product_id', unitId);
      await db.from('inventory').delete().eq('product_id', unitId);
      await db.from('products').delete().eq('id', unitId);
    }
  });
  it('a second re-ring payment is refused RERING_ALREADY_PAID once one is paid, and writes nothing; a retry of the first key still gets its stored answer', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const first = rkey(sale);
    const paid = await checkout(first);
    expect(paid).toMatchObject({ ok: true });
    const before = await movementCount();
    const tabsBefore = await tabCount();
    const second = rkey(sale);
    expect(await checkout(second)).toMatchObject({ ok: false, code: 'RERING_ALREADY_PAID' });
    expect(await paymentsFor(second)).toHaveLength(0);
    expect(await movementCount()).toBe(before);
    expect(await tabCount()).toBe(tabsBefore);
    expect(await checkout(first)).toMatchObject({ ok: true, idempotent: true, tabId: paid.tabId });
  });

  // tabs are version-guarded: every update must advance version by exactly 1
  async function setTab(id: string, patch: Record<string, unknown>): Promise<void> {
    const { data } = await db.from('tabs').select('version').eq('id', id).single();
    const { error } = await db.from('tabs').update({ ...patch, version: data.version + 1 }).eq('id', id);
    expect(error).toBeNull();
  }

  it('a fully refunded re-ring does not block a new one; a reopened, still-open re-ring tab does', async () => {
    const sale = newSale();
    await audit(sale, 'offline_sale.rering_approved');
    const first = rkey(sale);
    const paid = await checkout(first);
    expect(paid).toMatchObject({ ok: true });
    const { data: pay } = await db.from('payments').select('id, tab_id, amount').like('idempotency_key', `${first}%`).single();
    // reopened and open: the original payment is voided, the tab is open again
    await db.from('payments').update({ status: 'reopened_void' }).eq('id', pay.id);
    await setTab(pay.tab_id, { status: 'open', closed_at: null });
    expect(await checkout(rkey(sale))).toMatchObject({ ok: false, code: 'RERING_ALREADY_PAID' });
    // fully refunded: a negative is_refund row nets the tab to zero, the tab is closed
    await db.from('payments').update({ status: 'completed' }).eq('id', pay.id);
    await setTab(pay.tab_id, { status: 'paid', closed_at: new Date().toISOString() });
    const refund = await db.from('payments').insert({ tab_id: pay.tab_id, amount: -Number(pay.amount), method: 'cash', is_refund: true, processed_by: cashier.id, idempotency_key: `${first}-refund` });
    expect(refund.error).toBeNull();
    expect(await checkout(rkey(sale))).toMatchObject({ ok: true });
  });
});

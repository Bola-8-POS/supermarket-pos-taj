/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { supabase } from '@shared/lib/supabase';
import { findPaymentByIdempotencyKey } from './queries';

// MUST run before the imports are used: overrides the global Supabase mock so the lookup hits dev2.
vi.unmock('@shared/lib/supabase');

/**
 * Phase 30-03: can a signed-in cashier read "did key K commit?" from payments, and how does the
 * lookup behave. Creates its own throwaway cashiers (admin API, derived password) so no fixture
 * password reseed is needed. Target: dev2 only (127.0.0.1:56321).
 *
 * Run: npx vitest run --project integration src/entities/payment/model/findPaymentByIdempotencyKey.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__find_payment_by_key_test__';

interface TestUser {
  id: string;
  name: string;
  email: string;
  pin: string;
  password: string;
  client: any;
  token: string;
}

describe.skipIf(skip)('probe', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const mk = (tag: string): TestUser => ({ id: '', name: `${TAG}${tag}`, email: `${TAG}${tag}_${stamp}@test.local`, pin: '', password: '', client: null, token: '' });
  const cashierA = mk('a');
  const cashierB = mk('b');
  const users = [cashierA, cashierB];
  const keys: string[] = [];
  let shiftId = '';
  let cajaId = '';
  let terminalId = '';
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
    const { error: profileErr } = await db.from('profiles').upsert({ id: u.id, name: u.name, email: u.email, role: 'cashier', pin: u.pin, is_active: true });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    u.password = await deriveStaffPassword(newId, u.pin);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { data: session, error: signErr } = await u.client.auth.signInWithPassword({ email: u.email, password: await deriveStaffPassword(newId, u.pin) });
    if (signErr || !session.session) throw new Error(`sign in for ${u.name}: ${signErr?.message}`);
    u.token = session.session.access_token as string;
  }

  /** The same edge-function call the app makes (callProcessDirectSale), minus the browser plumbing. */
  async function sell(u: TestUser, idempotencyKey: string, split = false): Promise<Response> {
    keys.push(idempotencyKey);
    return fetch(`${url}/functions/v1/process-direct-sale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}`, apikey: anonKey! },
      body: JSON.stringify({
        items: [{ productId, quantity: 1, unitPrice: 10, modifierIds: [], modifierPriceDelta: 0 }],
        shiftId,
        cajaSessionId: cajaId,
        idempotencyKey,
        ...(split
          ? { expectedTotal: 10, legs: [{ method: 'cash', amount: 6, tenderedAmount: 6 }, { method: 'card', amount: 4, referenceNumber: 'REF1' }] }
          : { method: 'cash', amount: 10, tenderedAmount: 10 }),
        terminalId,
      }),
    });
  }

  const rowsFor = async (client: any, key: string) => client.from('payments').select('id').in('idempotency_key', [key, `${key}-leg0`]).limit(1);

  beforeAll(async () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
    for (const u of users) await makeUser(u);
    terminalId = `FP-${stamp.slice(-8)}`;
    const shift = await db.from('shifts').insert({ staff_id: cashierA.id, opening_cash: 0 }).select('id').single();
    if (shift.error) throw new Error(`shift: ${shift.error.message}`);
    shiftId = shift.data.id;
    const caja = await db.from('caja_sessions').insert({ opened_by: cashierA.id, opening_cash: 0, terminal_id: terminalId }).select('id').single();
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
      const { data } = await db.from('payments').select('id, tab_id').in('idempotency_key', [k, `${k}-leg0`]);
      for (const p of data ?? []) {
        await db.from('payments').delete().eq('id', p.id);
        const orderIds = (await db.from('orders').select('id').eq('tab_id', p.tab_id)).data?.map((o: { id: string }) => o.id) ?? [];
        if (orderIds.length) await db.from('order_items').delete().in('order_id', orderIds);
        await db.from('orders').delete().eq('tab_id', p.tab_id);
        await db.from('tabs').delete().eq('id', p.tab_id);
      }
    }
    const ids = users.map(u => u.id).filter(Boolean);
    if (ids.length) {
      await db.from('audit_logs').delete().in('actor_id', ids);
      await db.from('pin_attempts').delete().or(ids.map(i => `attempt_key.like.%${i}%`).join(','));
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
      await db.from('profiles').delete().eq('id', u.id);
      await db.auth.admin.deleteUser(u.id);
    }
  }, 120_000);

  it('probe: a committed sale is readable by key as the selling cashier and as another cashier', async () => {
    const key = `direct_sale_${TAG}${randomUUID()}`;
    const res = await sell(cashierA, key);
    const body = await res.text();
    expect(res.status, body.slice(0, 200)).toBe(200);
    const sold = JSON.parse(body) as { success: boolean; paymentId?: string };
    expect(sold.success).toBe(true);

    const mine = await rowsFor(cashierA.client, key);
    const same = !mine.error && mine.data?.length === 1 && mine.data[0].id === sold.paymentId ? 'ALLOWED' : 'REFUSED';
    const other = await rowsFor(cashierB.client, key);
    const otherRes = !other.error && other.data?.length === 1 && other.data[0].id === sold.paymentId ? 'ALLOWED' : 'REFUSED';
    const none = await rowsFor(cashierA.client, `direct_sale_${TAG}${randomUUID()}`);
    expect(none.error).toBeNull();
    expect(none.data).toEqual([]);

    process.stdout.write(`PROBE target=${url}\nRLS_SAME_USER: ${same}\nRLS_OTHER_CASHIER: ${otherRes}\n`);
    expect(['ALLOWED', 'REFUSED']).toContain(same);
  }, 60_000);

  describe('findPaymentByIdempotencyKey', () => {
    const newKey = () => `direct_sale_${TAG}${randomUUID()}`;
    beforeAll(async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: cashierB.email, password: cashierB.password });
      if (error) throw new Error(`sign in: ${error.message}`);
    });
    afterAll(async () => {
      await supabase.auth.signOut();
    });

    it('lookup returns completed with the payment id for a committed key', async () => {
      const key = newKey();
      const res = await sell(cashierA, key);
      expect(res.status).toBe(200);
      const sold = (await res.json()) as { paymentId: string };
      expect(await findPaymentByIdempotencyKey(key)).toEqual({
        ok: true,
        data: { status: 'completed', paymentId: sold.paymentId, tabId: expect.any(String) as string },
      });
    }, 60_000);

    it('lookup returns completed through key-leg0 for a split sale', async () => {
      const key = newKey();
      const res = await sell(cashierA, key, true);
      expect(res.status, (await res.clone().text()).slice(0, 200)).toBe(200);
      const found = await findPaymentByIdempotencyKey(key);
      expect(found.ok && found.data.status).toBe('completed');
    }, 60_000);

    it('lookup returns not_completed for a key that never reached the server', async () => {
      expect(await findPaymentByIdempotencyKey(newKey())).toEqual({
        ok: true,
        data: { status: 'not_completed' },
      });
    });
  });
});

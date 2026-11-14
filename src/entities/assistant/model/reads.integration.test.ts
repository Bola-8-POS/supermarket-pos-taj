/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { LOOKUP_ROW_CAP, expiryList, lowStock, productLookup, salesSummary } from './reads';

/**
 * Integration test: assistant product lookup on a cashier session (RLS products_select_authenticated).
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321).
 * Skips when absent; a skip is NOT VERIFIED (L48).
 *
 * Run: npx vitest run --project integration src/entities/assistant/model/reads.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__assistant_lookup_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));
const BARCODE = String(7000000000000 + Math.floor(Math.random() * 999999999999));

describe.skipIf(skip)('assistant productLookup', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const cashier = { id: '', pin: randomPin(), email: `${TAG}c_${stamp}@test.local`, client: null as any };
  const manager = { id: '', pin: randomPin(), email: `${TAG}m_${stamp}@test.local`, client: null as any };
  // 18 chars: satisfies the caja terminal_id CHECK (^[A-Za-z0-9_-]{1,32}$).
  const TERMINAL = `ASST-${stamp}`;
  const productIds: string[] = [];
  const supplierIds: string[] = [];
  let categoryId = '';

  async function callFn(name: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey! },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function addProduct(
    name: string,
    price: number,
    qty: number | null,
    barcode: string | null,
    expiry: string | null = null,
    lowThreshold = 10
  ): Promise<string> {
    const { data, error } = await db
      .from('products')
      .insert({ name, category_id: categoryId, base_price: price, is_active: true, sold_by_weight: false, barcode })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture product ${name}: ${error?.message}`);
    productIds.push(data.id as string);
    if (qty !== null) {
      const inv = await db
        .from('inventory')
        .insert({ product_id: data.id, quantity_on_hand: qty, expiry_date: expiry, low_stock_threshold: lowThreshold });
      if (inv.error) throw new Error(`fixture inventory ${name}: ${inv.error.message}`);
    }
    return data.id as string;
  }

  /** Derived-password staff (L49): same recipe as adjust-inventory-rpc.integration.test.ts. */
  async function createStaff(user: typeof cashier, role: 'cashier' | 'manager') {
    const newId = randomUUID();
    const created = await db.auth.admin.createUser({
      id: newId,
      email: user.email,
      password: await deriveStaffPassword(newId, user.pin),
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw new Error(`create ${role}: ${created.error?.message}`);
    user.id = created.data.user.id as string;
    const prof = await db
      .from('profiles')
      .upsert({ id: user.id, name: `${TAG}${role}`, email: user.email, role, pin: user.pin, is_active: true });
    if (prof.error) throw new Error(`profile: ${prof.error.message}`);
    const res = await callFn('staff-sign-in', { staffId: user.id, pin: user.pin });
    if (res.status !== 200) throw new Error(`sign in: ${res.status} ${JSON.stringify(res.json)}`);
    user.client = anon();
    const set = await user.client.auth.setSession({ access_token: res.json.accessToken, refresh_token: res.json.refreshToken });
    if (set.error) throw new Error(`setSession: ${set.error.message}`);
  }

  beforeAll(async () => {
    await createStaff(cashier, 'cashier');
    await createStaff(manager, 'manager');
    const cajaIns = await db
      .from('caja_sessions')
      .insert({ opened_by: manager.id, opening_cash: 100, status: 'open', terminal_id: TERMINAL });
    if (cajaIns.error) throw new Error(`fixture caja: ${cajaIns.error.message}`);

    const cat = await db.from('categories').select('id').limit(1).single();
    if (cat.error || !cat.data) throw new Error(`no category: ${cat.error?.message}`);
    categoryId = cat.data.id as string;

    const gheeId = await addProduct(`${TAG}Ghee Pure 500g`, 12.5, 7, BARCODE);
    const shelf = await db.from('products').update({ shelf_location: 'Pasillo 3 / A' }).eq('id', gheeId);
    if (shelf.error) throw new Error(`fixture shelf: ${shelf.error.message}`);
    // Expiry fixtures: two long-expired dates sort first on dev2 (deterministic under the 25-row cap), one far future.
    await addProduct(`${TAG}Milk expired`, 3, 5, null, '2000-01-01');
    await addProduct(`${TAG}Yogurt expired`, 3, 5, null, '2000-01-02');
    await addProduct(`${TAG}Wine far future`, 3, 5, null, '2099-12-31');
    // Low-stock fixtures: one product at 1 (threshold 10) linked to supplier Alpha; Beta only exists to make the name ambiguous.
    const lowId = await addProduct(`${TAG}Low Rice`, 4, 1, null, null, 10);
    for (const name of ['Alpha', 'Beta']) {
      const sup = await db.from('suppliers').insert({ name: `${TAG}Supplier ${name}` }).select('id').single();
      if (sup.error || !sup.data) throw new Error(`fixture supplier ${name}: ${sup.error?.message}`);
      supplierIds.push(sup.data.id as string);
    }
    const link = await db.from('supplier_products').insert({ supplier_id: supplierIds[0], product_id: lowId });
    if (link.error) throw new Error(`fixture supplier link: ${link.error.message}`);
    for (let i = 0; i < LOOKUP_ROW_CAP + 2; i++) await addProduct(`${TAG}bulk ${String(i).padStart(2, '0')}`, 1, 1, null);
  });

  afterAll(async () => {
    if (supplierIds.length) {
      await db.from('supplier_products').delete().in('supplier_id', supplierIds);
      await db.from('suppliers').delete().in('id', supplierIds);
    }
    if (productIds.length) {
      await db.from('inventory').delete().in('product_id', productIds);
      await db.from('products').delete().in('id', productIds);
    }
    await db.from('caja_sessions').delete().eq('terminal_id', TERMINAL);
    for (const user of [cashier, manager]) {
      if (!user.id) continue;
      await db.from('pin_attempts').delete().like('attempt_key', `%${user.id}%`);
      await db.from('profiles').delete().eq('id', user.id);
      await db.auth.admin.deleteUser(user.id);
    }
  });

  it('finds a seeded product by exact barcode with price and stock', async () => {
    const res = await productLookup(BARCODE, cashier.client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]).toMatchObject({ name: `${TAG}Ghee Pure 500g`, price: 12.5, quantityOnHand: 7, barcode: BARCODE, shelfLocation: 'Pasillo 3 / A' });
  });

  it('returns shelfLocation null for a product with no location recorded', async () => {
    const res = await productLookup(`${TAG}Low Rice`, cashier.client);
    expect(res.ok && res.data.rows[0]?.shelfLocation).toBeNull();
  });

  it('finds a seeded product by partial, case-insensitive name', async () => {
    const res = await productLookup(`${TAG}ghee pure`.toUpperCase(), cashier.client);
    expect(res.ok && res.data.rows.map(r => r.name)).toEqual([`${TAG}Ghee Pure 500g`]);
  });

  it('caps at 10 rows and reports more', async () => {
    const res = await productLookup(`${TAG}bulk`, cashier.client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows).toHaveLength(LOOKUP_ROW_CAP);
    expect(res.data.more).toBe(true);
  });

  it('gives an anon client zero rows (RLS products_select_authenticated)', async () => {
    const res = await productLookup(`${TAG}ghee`, anon());
    expect(res.ok && res.data.rows).toEqual([]);
  });

  it('lists expired products soonest first for a cashier session, with negative days', async () => {
    const res = await expiryList(7, cashier.client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ours = res.data.rows.filter(r => r.name.startsWith(TAG));
    expect(ours.map(r => r.name)).toEqual([`${TAG}Milk expired`, `${TAG}Yogurt expired`]);
    expect(ours.every(r => r.daysUntilExpiry < 0)).toBe(true);
    expect(res.data.rows.some(r => r.name === `${TAG}Wine far future`)).toBe(false);
  });

  it('gives an anon client zero expiry rows (RLS)', async () => {
    const res = await expiryList(7, anon());
    expect(res.ok && res.data.rows).toEqual([]);
  });

  it('cashier is refused the sales summary (20261108000001)', async () => {
    const res = await salesSummary(TERMINAL, cashier.client);
    expect(res).toEqual({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
  });

  it('manager gets the caja report for the terminal, equal to get_caja_report', async () => {
    const res = await salesSummary(TERMINAL, manager.client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const direct = await db.rpc('get_caja_report', { p_caja_id: res.data.cajaId });
    expect(direct.error).toBeNull();
    expect(res.data.summary).toEqual(direct.data.summary);
    expect(res.data.closedAt).toBeNull();
  });

  it('returns NO_CAJA for a terminal without a caja', async () => {
    expect(await salesSummary('ASST-NOCAJA', manager.client)).toEqual({ ok: false, error: { code: 'NO_CAJA' } });
  });

  it('refuses an anon client (no EXECUTE) and an inactive profile', async () => {
    const anonRes = await salesSummary(TERMINAL, anon());
    expect(anonRes.ok).toBe(false);
    const off = await db.from('profiles').update({ is_active: false }).eq('id', manager.id);
    expect(off.error).toBeNull();
    try {
      expect(await salesSummary(TERMINAL, manager.client)).toEqual({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
    } finally {
      await db.from('profiles').update({ is_active: true }).eq('id', manager.id);
    }
  });

  it('lists a seeded low-stock product for one supplier, for a cashier session', async () => {
    const res = await lowStock({ query: `${TAG}Supplier Alpha` }, cashier.client);
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.type !== 'rows') throw new Error('expected rows');
    expect(res.data.supplierName).toBe(`${TAG}Supplier Alpha`);
    expect(res.data.rows.map(r => r.name)).toEqual([`${TAG}Low Rice`]);
  });

  it('returns a typed choice when several suppliers match, then the rows for the chosen id', async () => {
    const res = await lowStock({ query: `${TAG}Supplier` }, cashier.client);
    expect(res.ok && res.data.type).toBe('choose');
    if (!res.ok || res.data.type !== 'choose') return;
    expect(res.data.options.map(o => o.name)).toEqual([`${TAG}Supplier Alpha`, `${TAG}Supplier Beta`]);
    const alpha = res.data.options[0]!;
    const picked = await lowStock({ supplierId: alpha.id }, cashier.client);
    expect(picked.ok && picked.data.type === 'rows' && picked.data.rows.map(r => r.name)).toEqual([`${TAG}Low Rice`]);
  });

  it('returns NOT_FOUND for an unknown supplier and gives an anon client no rows', async () => {
    expect(await lowStock({ query: 'zzz-no-such-supplier' }, cashier.client)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const anonAll = await lowStock({ query: null }, anon());
    expect(anonAll.ok && anonAll.data.type === 'rows' && anonAll.data.rows).toEqual([]);
    expect(await lowStock({ query: `${TAG}Supplier Alpha` }, anon())).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

/**
 * Plan 02c Task 8: full lists above the API row cap (local max_rows = 1000). Seeds 1,005 tagged
 * active products on dev2 and removes exactly those rows (by id) in afterAll.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchInventoryRows } from '@entities/inventory/model/queries';
import { fetchPromotionRows } from '@entities/promotion/model/queries';
import { fetchAllRows } from '@shared/lib/fetch-all-rows';
import type { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { unusedPin as unusedPinFor } from '../../../test/pin-helpers';
import { fetchProductRows } from './queries';

const TOTAL = 1005;
const TAG = 'ZZ-T8-FULL-LIST-';
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? process.env.VITE_SUPABASE_URL ?? '';

const ids = Array.from({ length: TOTAL }, () => crypto.randomUUID());
const nameOf = (i: number) => `${TAG}${String(i).padStart(4, '0')}`;
const chunk = <T>(a: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
let promotionId: string | undefined;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
let cashierId = '';
let cashier: typeof supabase;


async function cleanup(): Promise<void> {
  if (cashierId) {
    await testDb.from('profiles').delete().eq('id', cashierId);
    await testDb.auth.admin.deleteUser(cashierId);
  }
  if (promotionId) await testDb.from('promotions').delete().eq('id', promotionId);
  for (const part of chunk(ids, 100)) {
    await testDb.from('inventory').delete().in('product_id', part);
    await testDb.from('products').delete().in('id', part);
  }
}

describe('full lists above the row cap', () => {
  beforeAll(async () => {
    expect(url).toContain('127.0.0.1:56321');
    const { data: category } = await testDb.from('categories').select('id').limit(1).maybeSingle();
    if (!category?.id) throw new Error('run npm run setup:dev');
    try {
      cashierId = randomUUID();
      const pin = await unusedPinFor(testDb);
      const email = `${TAG}cashier@test.local`;
      const made = await testDb.auth.admin.createUser({
        id: cashierId, email, password: await deriveStaffPassword(cashierId, pin), email_confirm: true,
      });
      if (made.error) throw new Error(`create cashier: ${made.error.message}`);
      const prof = await testDb.from('profiles').upsert({ id: cashierId, name: `${TAG}cashier`, email, role: 'cashier', pin, is_active: true });
      if (prof.error) throw new Error(`cashier profile: ${prof.error.message}`);
      const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ staffId: cashierId, pin }),
      });
      if (res.status !== 200) throw new Error(`cashier sign-in ${res.status}`);
      const j = (await res.json()) as { accessToken: string; refreshToken: string };
      const client = createClient(url, anonKey, { auth: { persistSession: false } });
      const sess = await client.auth.setSession({ access_token: j.accessToken, refresh_token: j.refreshToken });
      if (sess.error) throw new Error(`cashier session: ${sess.error.message}`);
      cashier = client as unknown as typeof supabase;
      for (const part of chunk(ids, 500)) {
        const r = await testDb.from('products').insert(
          part.map(id => ({
            id,
            name: nameOf(ids.indexOf(id)),
            category_id: category.id,
            base_price: 1,
            is_active: true,
            sold_by_weight: false,
          }))
        );
        if (r.error) throw new Error(`seed products: ${JSON.stringify(r.error)}`);
      }
      const { data: have } = await testDb.from('inventory').select('product_id').in('product_id', ids.slice(0, 100));
      if ((have?.length ?? 0) < 100) {
        const present = new Set<string>();
        for (const part of chunk(ids, 100)) {
          const { data } = await testDb.from('inventory').select('product_id').in('product_id', part);
          data?.forEach(r => present.add(r.product_id));
        }
        const missing = ids.filter(id => !present.has(id)).map(product_id => ({ product_id, quantity_on_hand: 1 }));
        for (const part of chunk(missing, 500)) {
          const r = await testDb.from('inventory').insert(part);
          if (r.error) throw new Error(`seed inventory: ${JSON.stringify(r.error)}`);
        }
      }
      const promo = await testDb
        .from('promotions')
        .insert({
          name: `${TAG}promo`,
          discount_type: 'percent',
          discount_value: 10,
          starts_at: new Date(Date.now() - 86_400_000).toISOString(),
          ends_at: new Date(Date.now() + 86_400_000).toISOString(),
          active: false,
        })
        .select('id')
        .single();
      if (promo.error) throw new Error(`seed promotion: ${JSON.stringify(promo.error)}`);
      promotionId = promo.data.id;
      for (const part of chunk(ids, 500)) {
        const r = await testDb
          .from('promotion_targets')
          .insert(part.map(product_id => ({ promotion_id: promo.data.id, product_id })));
        if (r.error) throw new Error(`seed targets: ${JSON.stringify(r.error)}`);
      }
    } catch (e) {
      await cleanup();
      throw e;
    }
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    const { count } = await testDb.from('products').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(count).toBe(0);
    const promos = await testDb.from('promotions').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(promos.count).toBe(0);
    const profs = await testDb.from('profiles').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(profs.count).toBe(0);
  }, 120_000);

  it('with page size 2 five seeded products come back once each in name order', async () => {
    const five = ids.slice(0, 5);
    const r = await fetchAllRows(
      (from, to) =>
        testDb.from('products').select('id, name', { count: 'exact' }).in('id', five).order('name').order('id').range(from, to),
      { pageSize: 2 }
    );
    expect(r.ok && r.data.map(p => p.id)).toEqual(five);
  });

  it('1,005 seeded active products all reach the checkout list', async () => {
    const r = await fetchProductRows(cashier, { activeOnly: true });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.filter(p => p.name.startsWith(TAG))).toHaveLength(TOTAL);
    expect(new Set(r.data.map(p => p.id)).size).toBe(r.data.length);
  }, 60_000);

  it('the stock list returns every row above the cap', async () => {
    const r = await fetchInventoryRows(cashier);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.filter(i => i.product.name.startsWith(TAG))).toHaveLength(TOTAL);
  }, 60_000);

  it('the catalog list returns every row above the cap', async () => {
    const r = await fetchProductRows(cashier, { activeOnly: false });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.filter(p => p.name.startsWith(TAG))).toHaveLength(TOTAL);
  }, 60_000);

  it('a promotion targeting all 1,005 products keeps every target', async () => {
    const r = await fetchPromotionRows(cashier);
    if (!r.ok) throw new Error(r.error.message);
    const mine = r.data.find(p => p.id === promotionId);
    expect(mine?.promotion_targets).toHaveLength(TOTAL);
  }, 60_000);

  it("a promotion's embedded child counts match its merged children", async () => {
    const r = await cashier
      .from('promotions')
      .select('id, promotion_targets(count), promotion_combo_slots(count)')
      .eq('id', promotionId ?? '');
    expect(r.error).toBeNull();
    const row = r.data?.[0] as unknown as { promotion_targets: { count: number }[]; promotion_combo_slots: { count: number }[] };
    expect(row.promotion_targets[0]?.count).toBe(TOTAL);
    expect(row.promotion_combo_slots[0]?.count).toBe(0);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
/**
 * Integration tests: receive_shipment weighted-average cost + earliest-expiry
 * merge (Phase 07, Plan 01 — DATA-01 / ROADMAP Phase 7 Success Criterion #1).
 *
 * Mirrors src/entities/settings/model/receipt-settings-rls.integration.test.ts's
 * env-guard / describe.skipIf / safe() cleanup skeleton, but uses the
 * already-instantiated service-role `testDb` client directly — no signed-in
 * session is needed since `receive_shipment` takes an explicit `p_staff_id`
 * param, not `auth.uid()`.
 *
 * `suppliers`/`shipments`/`receive_shipment` are not yet in generated types
 * and `inventory`'s Row type is stale (missing `cost_price`/`expiry_date`,
 * added by 20260817000001_suppliers_receiving_expiry.sql) — DATA-03's types
 * regen (07-03, a later plan in this phase) fixes this. Per CLAUDE.md's
 * "Missing generated types workaround", cast to `any` here rather than block
 * on a regen that belongs to a different plan.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd supermarket-pos && npx vitest run src/features/receive-shipment/model/receive-shipment-weighted-avg.integration.test.ts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb as typedTestDb } from '@shared/lib/supabase-test-client';

const testDb = typedTestDb as any;

// ── Env guards ────────────────────────────────────────────────────────────────

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

/** Supabase query builders are thenable but don't expose `.catch()` as an
 * own method — wrap in a real Promise so cleanup calls can swallow errors. */
async function safe(p: PromiseLike<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // best-effort cleanup — ignore
  }
}

describe.skipIf(skip)('receive_shipment weighted-average cost (integration)', () => {
  let p_staff_id: string;
  let category_id: string;

  const IT_SUPPLIER_ID = 'aa110000-aa11-4a11-8a11-aa1100000001';
  const IT_PRODUCT_ID = 'bb220000-bb22-4b22-8b22-bb2200000002';

  beforeAll(async () => {
    const { data: staff } = await testDb
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'manager'])
      .limit(1)
      .maybeSingle();
    if (!staff?.id) throw new Error('run npm run setup:dev');
    p_staff_id = staff.id;

    const { data: category } = await testDb.from('categories').select('id').limit(1).maybeSingle();
    if (!category?.id) throw new Error('run npm run setup:dev');
    category_id = category.id;
  });

  beforeEach(async () => {
    const supplierR = await testDb
      .from('suppliers')
      .insert({ id: IT_SUPPLIER_ID, name: 'IT Weighted Avg Supplier' });
    if (supplierR.error) throw new Error(`beforeEach supplier: ${JSON.stringify(supplierR.error)}`);

    const productR = await testDb.from('products').insert({
      id: IT_PRODUCT_ID,
      name: 'IT Weighted Avg Product',
      category_id,
      base_price: 1,
      is_active: true,
      sold_by_weight: false,
    });
    if (productR.error) throw new Error(`beforeEach product: ${JSON.stringify(productR.error)}`);
  });

  afterEach(async () => {
    await safe(testDb.from('stock_movements').delete().eq('product_id', IT_PRODUCT_ID));
    await safe(testDb.from('inventory').delete().eq('product_id', IT_PRODUCT_ID));
    await safe(testDb.from('shipments').delete().eq('supplier_id', IT_SUPPLIER_ID));
    await safe(testDb.from('products').delete().eq('id', IT_PRODUCT_ID));
    await safe(testDb.from('suppliers').delete().eq('id', IT_SUPPLIER_ID));
  });

  it('weighted-average cost + earliest expiry after two receive_shipment calls on the same product (ROADMAP SC1)', async () => {
    const first = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: '2099-06-01' }],
    });
    expect(first.error).toBeNull();
    expect(first.data?.ok).toBe(true);

    const second = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 6, expiry_date: '2099-01-01' }],
    });
    expect(second.error).toBeNull();
    expect(second.data?.ok).toBe(true);

    const { data: inventoryRow, error: invErr } = await testDb
      .from('inventory')
      .select('quantity_on_hand, cost_price, expiry_date')
      .eq('product_id', IT_PRODUCT_ID)
      .single();
    expect(invErr).toBeNull();
    expect(inventoryRow?.quantity_on_hand).toBe(20);
    // Weighted average: (10*4 + 10*6) / 20 = 5
    expect(inventoryRow?.cost_price).toBe(5);
    // Earliest of the two expiry dates.
    expect(inventoryRow?.expiry_date).toBe('2099-01-01');
  });

  // ── D-02 / D-03 branch coverage ───────────────────────────────────────────
  // Each case uses its own fresh supplier/product pair (not the beforeEach
  // fixture above) so the cases can't interfere with each other, cleaning up
  // in a finally regardless of pass/fail — mirrors the IT_ITEM_BEER_WEIGHTED
  // try/finally precedent in product-sales-report.integration.test.ts.

  async function seedFreshProduct(supplierId: string, productId: string, name: string): Promise<void> {
    const supplierR = await testDb.from('suppliers').insert({ id: supplierId, name: `${name} Supplier` });
    if (supplierR.error) throw new Error(`seed supplier: ${JSON.stringify(supplierR.error)}`);
    const productR = await testDb.from('products').insert({
      id: productId,
      name,
      category_id,
      base_price: 1,
      is_active: true,
      sold_by_weight: false,
    });
    if (productR.error) throw new Error(`seed product: ${JSON.stringify(productR.error)}`);
  }

  async function cleanupFreshProduct(supplierId: string, productId: string): Promise<void> {
    await safe(testDb.from('stock_movements').delete().eq('product_id', productId));
    await safe(testDb.from('inventory').delete().eq('product_id', productId));
    await safe(testDb.from('shipments').delete().eq('supplier_id', supplierId));
    await safe(testDb.from('products').delete().eq('id', productId));
    await safe(testDb.from('suppliers').delete().eq('id', supplierId));
  }

  it('zero-stock replace-outright: stale expiry does not survive via LEAST (D-02)', async () => {
    const supplierId = 'aa110000-aa11-4a11-8a11-aa1100000003';
    const productId = 'bb220000-bb22-4b22-8b22-bb2200000004';
    await seedFreshProduct(supplierId, productId, 'IT Weighted Avg Zero Stock');
    try {
      const inventoryR = await testDb
        .from('inventory')
        .insert({ product_id: productId, quantity_on_hand: 0, cost_price: 1, expiry_date: '2020-01-01' });
      if (inventoryR.error) throw new Error(`seed inventory: ${JSON.stringify(inventoryR.error)}`);

      const result = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 9, expiry_date: '2099-03-01' }],
      });
      expect(result.error).toBeNull();
      expect(result.data?.ok).toBe(true);

      const { data: row } = await testDb
        .from('inventory')
        .select('cost_price, expiry_date')
        .eq('product_id', productId)
        .single();
      expect(row?.cost_price).toBe(9);
      expect(row?.expiry_date).toBe('2099-03-01');
    } finally {
      await cleanupFreshProduct(supplierId, productId);
    }
  });

  it('NULL-expiry truth table (a): NULL then real date → real date wins (D-03)', async () => {
    const supplierId = 'aa110000-aa11-4a11-8a11-aa1100000005';
    const productId = 'bb220000-bb22-4b22-8b22-bb2200000006';
    await seedFreshProduct(supplierId, productId, 'IT Weighted Avg Null A');
    try {
      const first = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: null }],
      });
      expect(first.error).toBeNull();
      expect(first.data?.ok).toBe(true);

      const second = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: '2099-02-01' }],
      });
      expect(second.error).toBeNull();
      expect(second.data?.ok).toBe(true);

      const { data: row } = await testDb
        .from('inventory')
        .select('expiry_date')
        .eq('product_id', productId)
        .single();
      expect(row?.expiry_date).toBe('2099-02-01');
    } finally {
      await cleanupFreshProduct(supplierId, productId);
    }
  });

  it('NULL-expiry truth table (b): real date then NULL → real date wins, order-independent (D-03)', async () => {
    const supplierId = 'aa110000-aa11-4a11-8a11-aa1100000007';
    const productId = 'bb220000-bb22-4b22-8b22-bb2200000008';
    await seedFreshProduct(supplierId, productId, 'IT Weighted Avg Null B');
    try {
      const first = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: '2099-02-01' }],
      });
      expect(first.error).toBeNull();
      expect(first.data?.ok).toBe(true);

      const second = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: null }],
      });
      expect(second.error).toBeNull();
      expect(second.data?.ok).toBe(true);

      const { data: row } = await testDb
        .from('inventory')
        .select('expiry_date')
        .eq('product_id', productId)
        .single();
      expect(row?.expiry_date).toBe('2099-02-01');
    } finally {
      await cleanupFreshProduct(supplierId, productId);
    }
  });

  it('NULL-expiry truth table (c): both NULL → NULL only when both sides are NULL (D-03)', async () => {
    const supplierId = 'aa110000-aa11-4a11-8a11-aa1100000009';
    const productId = 'bb220000-bb22-4b22-8b22-bb220000000a';
    await seedFreshProduct(supplierId, productId, 'IT Weighted Avg Null C');
    try {
      const first = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: null }],
      });
      expect(first.error).toBeNull();
      expect(first.data?.ok).toBe(true);

      const second = await testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: supplierId,
        p_items: [{ product_id: productId, quantity: 5, cost_price: 3, expiry_date: null }],
      });
      expect(second.error).toBeNull();
      expect(second.data?.ok).toBe(true);

      const { data: row } = await testDb
        .from('inventory')
        .select('expiry_date')
        .eq('product_id', productId)
        .single();
      expect(row?.expiry_date).toBeNull();
    } finally {
      await cleanupFreshProduct(supplierId, productId);
    }
  });
});

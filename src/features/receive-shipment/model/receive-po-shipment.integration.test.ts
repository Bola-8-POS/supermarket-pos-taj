/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
/**
 * Integration tests: receive_shipment(p_po_id) extension — atomic PO close,
 * double-receive guard, supplier-mismatch guard, and non-PO regression
 * (Phase 16, Plan 01 — PO-01/PO-03).
 *
 * Mirrors receive-shipment-weighted-avg.integration.test.ts's skeleton
 * exactly: service-role `testDb`, no signed-in session needed since
 * `receive_shipment` takes an explicit `p_staff_id` param.
 *
 * `purchase_orders`/`purchase_order_items` are not yet in generated types at
 * the moment this test is authored (RED phase) — cast to `any` per CLAUDE.md's
 * "Missing generated types workaround"; types are regenerated later in this
 * same task before the GREEN rerun.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd supermarket-pos && npx vitest run src/features/receive-shipment/model/receive-po-shipment.integration.test.ts
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

describe.skipIf(skip)('receive_shipment(p_po_id) extension (integration)', () => {
  let p_staff_id: string;
  let category_id: string;

  const IT_SUPPLIER_ID = 'cc330000-cc33-4c33-8c33-cc3300000001';
  const IT_SUPPLIER_2_ID = 'cc330000-cc33-4c33-8c33-cc3300000002';
  const IT_PRODUCT_ID = 'dd440000-dd44-4d44-8d44-dd4400000001';
  const IT_PRODUCT_NONPO_ID = 'dd440000-dd44-4d44-8d44-dd4400000002';
  const IT_PO_ID = 'ee550000-ee55-4e55-8e55-ee5500000001';
  const IT_PO_ITEM_ID = 'ff660000-ff66-4f66-8f66-ff6600000001';

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
      .insert({ id: IT_SUPPLIER_ID, name: 'IT PO Receive Supplier' });
    if (supplierR.error) throw new Error(`beforeEach supplier: ${JSON.stringify(supplierR.error)}`);

    const supplier2R = await testDb
      .from('suppliers')
      .insert({ id: IT_SUPPLIER_2_ID, name: 'IT PO Receive Supplier 2' });
    if (supplier2R.error) throw new Error(`beforeEach supplier2: ${JSON.stringify(supplier2R.error)}`);

    const productR = await testDb.from('products').insert({
      id: IT_PRODUCT_ID,
      name: 'IT PO Receive Product',
      category_id,
      base_price: 1,
      is_active: true,
      sold_by_weight: false,
    });
    if (productR.error) throw new Error(`beforeEach product: ${JSON.stringify(productR.error)}`);

    const productNonPoR = await testDb.from('products').insert({
      id: IT_PRODUCT_NONPO_ID,
      name: 'IT PO Receive Product (non-PO)',
      category_id,
      base_price: 1,
      is_active: true,
      sold_by_weight: false,
    });
    if (productNonPoR.error)
      throw new Error(`beforeEach productNonPo: ${JSON.stringify(productNonPoR.error)}`);

    const poR = await testDb
      .from('purchase_orders')
      .insert({ id: IT_PO_ID, supplier_id: IT_SUPPLIER_ID, status: 'draft', created_by: p_staff_id });
    if (poR.error) throw new Error(`beforeEach purchase_orders: ${JSON.stringify(poR.error)}`);

    const poItemR = await testDb.from('purchase_order_items').insert({
      id: IT_PO_ITEM_ID,
      purchase_order_id: IT_PO_ID,
      product_id: IT_PRODUCT_ID,
      quantity: 10,
      cost_price: 4,
    });
    if (poItemR.error)
      throw new Error(`beforeEach purchase_order_items: ${JSON.stringify(poItemR.error)}`);
  });

  afterEach(async () => {
    await safe(testDb.from('stock_movements').delete().eq('product_id', IT_PRODUCT_ID));
    await safe(testDb.from('stock_movements').delete().eq('product_id', IT_PRODUCT_NONPO_ID));
    await safe(testDb.from('inventory').delete().eq('product_id', IT_PRODUCT_ID));
    await safe(testDb.from('inventory').delete().eq('product_id', IT_PRODUCT_NONPO_ID));
    await safe(testDb.from('purchase_order_items').delete().eq('id', IT_PO_ITEM_ID));
    await safe(testDb.from('purchase_orders').delete().eq('id', IT_PO_ID));
    await safe(testDb.from('shipments').delete().eq('supplier_id', IT_SUPPLIER_ID));
    await safe(testDb.from('shipments').delete().eq('supplier_id', IT_SUPPLIER_2_ID));
    await safe(testDb.from('products').delete().eq('id', IT_PRODUCT_ID));
    await safe(testDb.from('products').delete().eq('id', IT_PRODUCT_NONPO_ID));
    await safe(testDb.from('suppliers').delete().eq('id', IT_SUPPLIER_ID));
    await safe(testDb.from('suppliers').delete().eq('id', IT_SUPPLIER_2_ID));
  });

  it('Test 1: atomic close — receiving with p_po_id updates inventory AND closes the PO in one call', async () => {
    const result = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: null }],
      p_po_id: IT_PO_ID,
    });
    expect(result.error).toBeNull();
    expect(result.data?.ok).toBe(true);

    const { data: poRow, error: poErr } = await testDb
      .from('purchase_orders')
      .select('status, received_at')
      .eq('id', IT_PO_ID)
      .single();
    expect(poErr).toBeNull();
    expect(poRow?.status).toBe('received');
    expect(poRow?.received_at).not.toBeNull();

    const { data: invRow, error: invErr } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_ID)
      .single();
    expect(invErr).toBeNull();
    expect(invRow?.quantity_on_hand).toBe(10);
  });

  it('Test 2: double-receive guard — a second call with the same p_po_id is rejected, no second mutation', async () => {
    const first = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: null }],
      p_po_id: IT_PO_ID,
    });
    expect(first.error).toBeNull();
    expect(first.data?.ok).toBe(true);

    const { data: afterFirst } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_ID)
      .single();
    expect(afterFirst?.quantity_on_hand).toBe(10);

    const second = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: null }],
      p_po_id: IT_PO_ID,
    });
    expect(second.error).toBeNull();
    expect(second.data?.ok).toBe(false);
    expect(second.data?.code).toBe('PO_ALREADY_RECEIVED');

    const { data: afterSecond } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_ID)
      .single();
    expect(afterSecond?.quantity_on_hand).toBe(10);
  });

  it('Test 3: supplier-mismatch guard — a p_po_id belonging to a different supplier is rejected before any mutation', async () => {
    const result = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_2_ID,
      p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: null }],
      p_po_id: IT_PO_ID,
    });
    expect(result.error).toBeNull();
    expect(result.data?.ok).toBe(false);
    expect(result.data?.code).toBe('PO_SUPPLIER_MISMATCH');

    const { data: invRow } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_ID)
      .maybeSingle();
    expect(invRow).toBeNull();

    const { data: poRow } = await testDb
      .from('purchase_orders')
      .select('status')
      .eq('id', IT_PO_ID)
      .single();
    expect(poRow?.status).toBe('draft');
  });

  it('Test 4: non-PO regression — exactly 3 named args (no p_po_id) still resolves to one function', async () => {
    const result = await testDb.rpc('receive_shipment', {
      p_staff_id,
      p_supplier_id: IT_SUPPLIER_ID,
      p_items: [{ product_id: IT_PRODUCT_NONPO_ID, quantity: 5, cost_price: 2, expiry_date: null }],
    });
    expect(result.error).toBeNull();
    expect(result.data?.ok).toBe(true);

    const { data: invRow, error: invErr } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_NONPO_ID)
      .single();
    expect(invErr).toBeNull();
    expect(invRow?.quantity_on_hand).toBe(5);
  });

  it('Test 5: concurrent double-receive guard — two genuinely simultaneous calls with the same p_po_id never both succeed (16-REVIEW.md CR-01)', async () => {
    // Test 2 above only proves the guard works when the calls are sequential
    // (await-then-call) — that can't detect a check-then-act race, since the
    // first call's row lock is already released by the time the second
    // starts. Promise.all fires both requests before either resolves, so
    // this is the only test that actually exercises the SELECT ... FOR
    // UPDATE row lock in the receive_shipment migration.
    const call = () =>
      testDb.rpc('receive_shipment', {
        p_staff_id,
        p_supplier_id: IT_SUPPLIER_ID,
        p_items: [{ product_id: IT_PRODUCT_ID, quantity: 10, cost_price: 4, expiry_date: null }],
        p_po_id: IT_PO_ID,
      });
    const [first, second] = await Promise.all([call(), call()]);

    const results = [first, second];
    const succeeded = results.filter(r => r.data?.ok === true);
    const rejected = results.filter(r => r.data?.ok === false);
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.data?.code).toBe('PO_ALREADY_RECEIVED');

    const { data: invRow, error: invErr } = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', IT_PRODUCT_ID)
      .single();
    expect(invErr).toBeNull();
    expect(invRow?.quantity_on_hand).toBe(10);
  });
});

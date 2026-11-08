import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: purchase_orders/purchase_order_items RLS (Phase 16,
 * Plan 01 — D-02 boundary). Mirrors
 * src/entities/audit-log/model/rls-denial.integration.test.ts's
 * temp-user-creation + signInWithPassword + two-client-shape +
 * dual-denial-assertion pattern.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY in the environment. Skips gracefully (does not
 * fail) when live creds are absent.
 *
 * DEPENDENCY: this test requires the purchase_orders/purchase_order_items
 * tables + RLS policies from
 * supabase/migrations/20260823000001_purchase_orders.sql to be LIVE on the
 * target Supabase project (this plan's own Task 1 output).
 *
 * Two roles, two clients each:
 *   db              — service-role client: bypasses RLS for setup/teardown
 *                      and seeding the target PO/PO-item rows.
 *   managerClient    — authenticated (manager role) client: manage_products
 *                      RLS permits full access — sanity check on the seeded row.
 *   cashierClient    — authenticated (cashier role) client: manage_products
 *                      RLS denies every operation — the D-02 boundary under test.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('purchase_orders/purchase_order_items RLS (D-02 boundary)', () => {
  // Each client gets its own storageKey — supabase-js's default auth storage
  // is keyed by project ref only, so three same-process clients (service-role
  // + two signed-in sessions) would otherwise clobber each other's session,
  // silently turning the service-role `db` client into an authenticated
  // (RLS-bound) client after the anon clients sign in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'po-rls-test-service-role' },
  }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const managerClient = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'po-rls-test-manager' },
  }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cashierClient = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'po-rls-test-cashier' },
  }) as any;

  let managerUserId: string;
  let cashierUserId: string;
  let supplierId: string;
  let productId: string;
  let poId: string;
  let poItemId: string;

  beforeAll(async () => {
    const stamp = String(Date.now());

    // 0. Create temp manager + cashier test users and sign each into its
    //    own client instance, so the two clients carry real, non-service-role
    //    JWTs with different roles.
    const managerEmail = `__po_rls_test_manager_${stamp}@test.local`;
    const cashierEmail = `__po_rls_test_cashier_${stamp}@test.local`;
    const password = 'TestPoRls123!';

    const { data: managerAuth, error: managerCreateErr } = await db.auth.admin.createUser({
      email: managerEmail,
      password,
      email_confirm: true,
    });
    if (managerCreateErr || !managerAuth.user)
      throw new Error(`manager test user create: ${managerCreateErr?.message}`);
    managerUserId = managerAuth.user.id as string;

    const { data: cashierAuth, error: cashierCreateErr } = await db.auth.admin.createUser({
      email: cashierEmail,
      password,
      email_confirm: true,
    });
    if (cashierCreateErr || !cashierAuth.user)
      throw new Error(`cashier test user create: ${cashierCreateErr?.message}`);
    cashierUserId = cashierAuth.user.id as string;

    const { error: managerProfileErr } = await db.from('profiles').upsert({
      id: managerUserId,
      name: '__po_rls_test_manager__',
      email: managerEmail,
      role: 'manager',
      pin: '999996',
      is_active: true,
    });
    if (managerProfileErr) throw new Error(`manager profile upsert: ${managerProfileErr.message}`);

    const { error: cashierProfileErr } = await db.from('profiles').upsert({
      id: cashierUserId,
      name: '__po_rls_test_cashier__',
      email: cashierEmail,
      role: 'cashier',
      pin: '999997',
      is_active: true,
    });
    if (cashierProfileErr) throw new Error(`cashier profile upsert: ${cashierProfileErr.message}`);

    const { error: managerSignInErr } = await managerClient.auth.signInWithPassword({
      email: managerEmail,
      password,
    });
    if (managerSignInErr) throw new Error(`manager sign in: ${managerSignInErr.message}`);

    const { error: cashierSignInErr } = await cashierClient.auth.signInWithPassword({
      email: cashierEmail,
      password,
    });
    if (cashierSignInErr) throw new Error(`cashier sign in: ${cashierSignInErr.message}`);

    // 1. Seed a real supplier + product + purchase_orders row (status='draft')
    //    + one purchase_order_items row via the service-role client (bypasses
    //    RLS for setup) so there is a concrete row to attempt access on.
    const { data: category } = await db.from('categories').select('id').limit(1).maybeSingle();
    if (!category?.id) throw new Error('run npm run setup:dev');

    const { data: supplier, error: supplierErr } = await db
      .from('suppliers')
      .insert({ name: '__po_rls_test_supplier__' })
      .select('id')
      .single();
    if (supplierErr || !supplier) throw new Error(`supplier seed: ${supplierErr?.message}`);
    supplierId = (supplier as { id: string }).id;

    const { data: product, error: productErr } = await db
      .from('products')
      .insert({
        name: '__po_rls_test_product__',
        category_id: category.id,
        base_price: 1,
        is_active: true,
        sold_by_weight: false,
      })
      .select('id')
      .single();
    if (productErr || !product) throw new Error(`product seed: ${productErr?.message}`);
    productId = (product as { id: string }).id;

    const { data: po, error: poErr } = await db
      .from('purchase_orders')
      .insert({ supplier_id: supplierId, status: 'draft', created_by: managerUserId })
      .select('id')
      .single();
    if (poErr || !po) throw new Error(`purchase_orders seed: ${poErr?.message}`);
    poId = (po as { id: string }).id;

    const { data: poItem, error: poItemErr } = await db
      .from('purchase_order_items')
      .insert({ purchase_order_id: poId, product_id: productId, quantity: 5, cost_price: 3 })
      .select('id')
      .single();
    if (poItemErr || !poItem) throw new Error(`purchase_order_items seed: ${poItemErr?.message}`);
    poItemId = (poItem as { id: string }).id;
  });

  afterAll(async () => {
    await managerClient.auth.signOut();
    await cashierClient.auth.signOut();

    if (poItemId) await db.from('purchase_order_items').delete().eq('id', poItemId);
    if (poId) await db.from('purchase_orders').delete().eq('id', poId);
    if (productId) await db.from('products').delete().eq('id', productId);
    if (supplierId) await db.from('suppliers').delete().eq('id', supplierId);
    if (managerUserId) {
      await db.from('profiles').delete().eq('id', managerUserId);
      await db.auth.admin.deleteUser(managerUserId);
    }
    if (cashierUserId) {
      await db.from('profiles').delete().eq('id', cashierUserId);
      await db.auth.admin.deleteUser(cashierUserId);
    }
  });

  it('Test 1 (sanity): a manager client SELECTs the seeded purchase_orders row and gets it back', async () => {
    const { data, error } = await managerClient
      .from('purchase_orders')
      .select('id')
      .eq('id', poId)
      .single();

    expect(error).toBeNull();
    expect((data as { id: string } | null)?.id).toBe(poId);
  });

  it('Test 2 (D-02 boundary): a cashier client SELECTs purchase_orders (no filter) and gets an empty array', async () => {
    const { data, error } = await cashierClient.from('purchase_orders').select('id');

    // RLS silently filters — an empty array, not a thrown error.
    expect(error).toBeNull();
    expect(data as unknown[]).toHaveLength(0);
  });

  it('Test 3: a cashier client INSERT into purchase_order_items referencing the seeded PO is denied', async () => {
    const { data, error } = await cashierClient
      .from('purchase_order_items')
      .insert({ purchase_order_id: poId, product_id: productId, quantity: 1, cost_price: 1 })
      .select();

    // No INSERT policy grants cashier access -> either a Postgres RLS error,
    // or a 0-row-affected result — assert whichever shape occurs.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data as unknown[]).toHaveLength(0);
    }

    // The seeded item count must be unchanged regardless of denial shape.
    const { data: items, error: itemsErr } = await db
      .from('purchase_order_items')
      .select('id')
      .eq('purchase_order_id', poId);
    expect(itemsErr).toBeNull();
    expect((items as { id: string }[] | null)?.length).toBe(1);
  });

  it('Test 4: a cashier client SELECTs purchase_order_items for the seeded PO and gets an empty array', async () => {
    const { data, error } = await cashierClient
      .from('purchase_order_items')
      .select('id')
      .eq('purchase_order_id', poId);

    expect(error).toBeNull();
    expect(data as unknown[]).toHaveLength(0);
  });
});

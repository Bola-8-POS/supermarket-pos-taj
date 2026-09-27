/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: adjust_inventory RPC — stock adjustments and counts go
 * through one RPC that locks the row, checks an optional expected quantity,
 * and writes the ledger row and the audit row together (wave 3a stock
 * adjustments).
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack, edge runtime running for staff-sign-in). Skips gracefully when absent.
 *
 * Run: npx vitest run src/entities/inventory/model/adjust-inventory-rpc.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__adjust_inventory_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'manager' | 'cashier';
  pin: string;
  client: any;
}

describe.skipIf(skip)('adjust_inventory RPC', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());

  const manager: Fixture = { id: '', name: `${TAG}manager`, email: `${TAG}m_${stamp}@test.local`, role: 'manager', pin: randomPin(), client: null };
  const cashier: Fixture = { id: '', name: `${TAG}cashier`, email: `${TAG}c_${stamp}@test.local`, role: 'cashier', pin: randomPin(), client: null };
  const fixtures = [manager, cashier];
  let productId = '';
  let inventoryRowId = '';

  async function callFn(name: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey! },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function makeFixture(f: Fixture): Promise<void> {
    const { data, error } = await db.auth.admin.createUser({ email: f.email, password: f.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user ${f.name}: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert ${f.name}: ${profileErr.message}`);
  }

  async function signIn(f: Fixture): Promise<void> {
    const res = await callFn('staff-sign-in', { staffId: f.id, pin: f.pin });
    if (res.status !== 200) throw new Error(`sign in ${f.name}: ${res.status} ${JSON.stringify(res.json)}`);
    const client = anon();
    const { error } = await client.auth.setSession({
      access_token: res.json.accessToken,
      refresh_token: res.json.refreshToken,
    });
    if (error) throw new Error(`setSession ${f.name}: ${error.message}`);
    f.client = client;
  }

  async function removeFixture(f: Fixture): Promise<void> {
    if (!f.id) return;
    // Defense against cross-test contamination: another integration test's
    // "pick any staff" seed helper can adopt a still-live fixture profile as
    // its staff member before this file's own teardown runs, attaching
    // stock_movements/shifts rows this file never created. Delete by
    // staff_id directly so a leftover reference never blocks the profile
    // delete below.
    const movDel = await db.from('stock_movements').delete().eq('staff_id', f.id);
    expect(movDel.error).toBeNull();
    const shiftDel = await db.from('shifts').delete().eq('staff_id', f.id);
    expect(shiftDel.error).toBeNull();
    await db.from('pin_attempts').delete().like('attempt_key', `%${f.id}%`);
    const profDel = await db.from('profiles').delete().eq('id', f.id).select('id');
    expect(profDel.error).toBeNull();
    expect(profDel.data).toHaveLength(1);
    const { error: authErr } = await db.auth.admin.deleteUser(f.id);
    expect(authErr).toBeNull();
  }

  async function currentQty(): Promise<number> {
    const { data } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    return Number(data?.quantity_on_hand ?? 0);
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);
    await signIn(manager);
    await signIn(cashier);

    // Dedicated tagged fixture product (not a shared live catalog product):
    // adjust_inventory permanently moves quantity_on_hand and writes ledger
    // rows, so this file creates and owns its own product + inventory row,
    // deleted in afterAll (same pattern as
    // receive-po-shipment.integration.test.ts's IT_PRODUCT_ID).
    const { data: category, error: categoryErr } = await db.from('categories').select('id').limit(1).single();
    if (categoryErr || !category) throw new Error(`no category: ${categoryErr?.message}`);
    const { data: product, error: productErr } = await db
      .from('products')
      .insert({ name: `${TAG}product`, category_id: category.id, base_price: 1, is_active: true, sold_by_weight: false })
      .select('id')
      .single();
    if (productErr || !product) throw new Error(`fixture product insert: ${productErr?.message}`);
    productId = product.id as string;

    const { data: inv, error: invErr } = await db
      .from('inventory')
      .insert({ product_id: productId, quantity_on_hand: 100 })
      .select('id')
      .single();
    if (invErr || !inv) throw new Error(`fixture inventory insert: ${invErr?.message}`);
    inventoryRowId = inv.id as string;
  });

  afterAll(async () => {
    const movDel = await db.from('stock_movements').delete().eq('product_id', productId);
    expect(movDel.error).toBeNull();
    const auditDel = await db.from('audit_logs').delete().eq('action', 'inventory.adjust').eq('entity_id', inventoryRowId);
    expect(auditDel.error).toBeNull();
    const invDel = await db.from('inventory').delete().eq('product_id', productId);
    expect(invDel.error).toBeNull();
    const prodDel = await db.from('products').delete().eq('id', productId);
    expect(prodDel.error).toBeNull();
    for (const f of fixtures) await removeFixture(f);
  });

  it('applies a positive delta, writes one ledger row and one audit row, both attributed to the caller', async () => {
    const before = await currentQty();

    const { data, error } = await manager.client.rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 5,
      p_reason: 'manual_adjustment',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, quantityOnHand: before + 5 });

    const { data: movements } = await db
      .from('stock_movements')
      .select('id, staff_id, quantity_delta')
      .eq('product_id', productId)
      .eq('reason', 'manual_adjustment');
    expect(movements).toHaveLength(1);
    expect(movements![0].staff_id).toBe(manager.id);
    expect(Number(movements![0].quantity_delta)).toBe(5);

    // No .limit(1): capping the query at 1 row would make "exactly one"
    // vacuous — it would pass even if the RPC wrote a second row.
    const { data: auditRows } = await db
      .from('audit_logs')
      .select('actor_id')
      .eq('action', 'inventory.adjust')
      .eq('entity_id', inventoryRowId);
    expect(auditRows).toHaveLength(1);
    expect(auditRows![0].actor_id).toBe(manager.id);
  });

  it('refuses a stale expected quantity: STOCK_CHANGED, stock and ledger unchanged', async () => {
    const before = await currentQty();
    const { count: movementsBefore } = await db
      .from('stock_movements')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', productId);

    const { data, error } = await manager.client.rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 3,
      p_reason: 'manual_adjustment',
      p_expected_quantity: before - 1,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain('STOCK_CHANGED');
    expect(await currentQty()).toBe(before);

    const { count: movementsAfter } = await db
      .from('stock_movements')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', productId);
    expect(movementsAfter).toBe(movementsBefore);
  });

  it('refuses a zero delta: INVALID_DELTA', async () => {
    const { data, error } = await manager.client.rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 0,
      p_reason: 'manual_adjustment',
    });
    expect(data).toBeNull();
    expect(error?.message).toContain('INVALID_DELTA');
  });

  it('refuses a blank reason: INVALID_REASON', async () => {
    const { data, error } = await manager.client.rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 1,
      p_reason: '   ',
    });
    expect(data).toBeNull();
    expect(error?.message).toContain('INVALID_REASON');
  });

  it('refuses a cashier session: AUTH_FORBIDDEN', async () => {
    const { data, error } = await cashier.client.rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 1,
      p_reason: 'manual_adjustment',
    });
    expect(data).toBeNull();
    expect(error?.message).toContain('AUTH_FORBIDDEN');
  });

  it('refuses an anonymous client', async () => {
    const { error } = await anon().rpc('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 1,
      p_reason: 'manual_adjustment',
    });
    expect(error).not.toBeNull();
  });

  it('refuses an unknown product: NOT_FOUND', async () => {
    const { data, error } = await manager.client.rpc('adjust_inventory', {
      p_product_id: '00000000-0000-0000-0000-000000000000',
      p_quantity_delta: 1,
      p_reason: 'manual_adjustment',
    });
    expect(data).toBeNull();
    expect(error?.message).toContain('NOT_FOUND');
  });
});

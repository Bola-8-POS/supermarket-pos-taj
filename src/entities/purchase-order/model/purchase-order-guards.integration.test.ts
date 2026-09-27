/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: purchase order guards (wave 3a) — a received
 * purchase order is read-only in RLS and in update_purchase_order_atomic;
 * receive_shipment replays an idempotency key instead of creating a second
 * shipment.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack, edge runtime running for staff-sign-in). Skips gracefully when absent.
 *
 * Run: npx vitest run src/entities/purchase-order/model/purchase-order-guards.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__po_guards_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'manager';
  pin: string;
  client: any;
}

describe.skipIf(skip)('purchase order guards', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());

  const manager: Fixture = { id: '', name: `${TAG}manager`, email: `${TAG}m_${stamp}@test.local`, role: 'manager', pin: randomPin(), client: null };
  let supplierId = '';
  let productId = '';
  const poIds: string[] = [];
  const shipmentIds: string[] = [];

  async function callFn(name: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey! },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function seedPo(status: 'draft' | 'received'): Promise<string> {
    const { data: po, error: poErr } = await db
      .from('purchase_orders')
      .insert({ supplier_id: supplierId, status: 'draft', created_by: manager.id })
      .select('id')
      .single();
    if (poErr || !po) throw new Error(`po insert: ${poErr?.message}`);
    poIds.push(po.id);

    const { error: itemErr } = await db
      .from('purchase_order_items')
      .insert({ purchase_order_id: po.id, product_id: productId, quantity: 1, cost_price: 5 });
    if (itemErr) throw new Error(`po item insert: ${itemErr.message}`);

    if (status === 'received') {
      const { error: recvErr } = await db
        .from('purchase_orders')
        .update({ status: 'received', received_at: new Date().toISOString() })
        .eq('id', po.id);
      if (recvErr) throw new Error(`po receive: ${recvErr.message}`);
    }
    return po.id as string;
  }

  async function cleanupPo(poId: string): Promise<void> {
    await db.from('purchase_order_items').delete().eq('purchase_order_id', poId);
    await db.from('purchase_orders').delete().eq('id', poId);
  }

  beforeAll(async () => {
    const { data, error } = await db.auth.admin.createUser({ email: manager.email, password: manager.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user manager: ${error?.message}`);
    manager.id = data.user.id as string;
    const { error: profileErr } = await db
      .from('profiles')
      .upsert({ id: manager.id, name: manager.name, email: manager.email, role: manager.role, pin: manager.pin, is_active: true });
    if (profileErr) throw new Error(`profile upsert manager: ${profileErr.message}`);

    const res = await callFn('staff-sign-in', { staffId: manager.id, pin: manager.pin });
    if (res.status !== 200) throw new Error(`sign in manager: ${res.status} ${JSON.stringify(res.json)}`);
    manager.client = anon();
    const { error: sessErr } = await manager.client.auth.setSession({
      access_token: res.json.accessToken,
      refresh_token: res.json.refreshToken,
    });
    if (sessErr) throw new Error(`setSession manager: ${sessErr.message}`);

    const { data: supplier, error: supplierErr } = await db
      .from('suppliers')
      .insert({ name: `${TAG}supplier_${stamp}` })
      .select('id')
      .single();
    if (supplierErr || !supplier) throw new Error(`supplier insert: ${supplierErr?.message}`);
    supplierId = supplier.id as string;

    // Dedicated tagged fixture product (not a shared live catalog product):
    // receive_shipment permanently moves quantity_on_hand and writes ledger
    // rows, so this file creates and owns its own product, deleted in
    // afterAll (same pattern as receive-po-shipment.integration.test.ts's
    // IT_PRODUCT_ID). receive_shipment upserts its own inventory row, so no
    // inventory row is pre-created here — only cleaned up.
    const { data: category, error: categoryErr } = await db.from('categories').select('id').limit(1).single();
    if (categoryErr || !category) throw new Error(`no category: ${categoryErr?.message}`);
    const { data: product, error: productErr } = await db
      .from('products')
      .insert({ name: `${TAG}product`, category_id: category.id, base_price: 1, is_active: true, sold_by_weight: false })
      .select('id')
      .single();
    if (productErr || !product) throw new Error(`fixture product insert: ${productErr?.message}`);
    productId = product.id as string;
  });

  afterAll(async () => {
    for (const shipmentId of shipmentIds) await db.from('shipments').delete().eq('id', shipmentId);
    for (const poId of [...poIds]) await cleanupPo(poId).catch(() => undefined);
    if (supplierId) await db.from('suppliers').delete().eq('id', supplierId);

    const movDel = await db.from('stock_movements').delete().eq('product_id', productId);
    expect(movDel.error).toBeNull();
    const invDel = await db.from('inventory').delete().eq('product_id', productId);
    expect(invDel.error).toBeNull();
    const prodDel = await db.from('products').delete().eq('id', productId);
    expect(prodDel.error).toBeNull();

    if (manager.id) {
      // Defense against cross-test contamination (see
      // remove-tab-item-rpc.integration.test.ts's removeFixture comment):
      // sweep by staff_id directly, not only by this file's own tracked ids,
      // before the profile delete itself.
      const staffMovDel = await db.from('stock_movements').delete().eq('staff_id', manager.id);
      expect(staffMovDel.error).toBeNull();
      const shiftDel = await db.from('shifts').delete().eq('staff_id', manager.id);
      expect(shiftDel.error).toBeNull();
      await db.from('pin_attempts').delete().like('attempt_key', `%${manager.id}%`);
      const profDel = await db.from('profiles').delete().eq('id', manager.id).select('id');
      expect(profDel.error).toBeNull();
      expect(profDel.data).toHaveLength(1);
      const { error: authErr } = await db.auth.admin.deleteUser(manager.id);
      expect(authErr).toBeNull();
    }
  });

  it('a draft PO updated through update_purchase_order_atomic replaces its items', async () => {
    const poId = await seedPo('draft');
    const { error } = await manager.client.rpc('update_purchase_order_atomic', {
      p_id: poId,
      p_supplier_id: supplierId,
      p_items: [{ productId, quantity: 7, costPrice: 9.5 }],
    });
    expect(error).toBeNull();
    const { data: items } = await db.from('purchase_order_items').select('quantity, cost_price').eq('purchase_order_id', poId);
    expect(items).toHaveLength(1);
    expect(items![0].quantity).toBe(7);
  });

  it('a received PO refuses update_purchase_order_atomic; items unchanged', async () => {
    // Postgres RLS note (found while writing this test, not in the plan):
    // `SELECT ... FOR UPDATE` under RLS is gated by the UPDATE policy's
    // USING clause as well as the SELECT policy's — since
    // purchase_orders_update_draft's USING requires status = 'draft', an
    // authenticated manager's FOR UPDATE lock on a received row is refused
    // visibility entirely, so the row reads as NOT FOUND and the function's
    // own `v_status <> 'draft'` PO_RECEIVED branch is never reached for any
    // RLS-bound caller. Either way the write is refused and nothing
    // changes; PO_RECEIVED stays reachable for a caller that reads with RLS
    // disabled (service_role), which is what the static check in
    // verify-stock-and-line-bounds.sql (prosrc contains PO_RECEIVED) pins.
    const poId = await seedPo('received');
    const { error } = await manager.client.rpc('update_purchase_order_atomic', {
      p_id: poId,
      p_supplier_id: supplierId,
      p_items: [{ productId, quantity: 99, costPrice: 1 }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('PO_NOT_FOUND');
    const { data: items } = await db.from('purchase_order_items').select('quantity').eq('purchase_order_id', poId);
    expect(items).toHaveLength(1);
    expect(items![0].quantity).toBe(1);
  });

  it('a manager cannot insert a PO that is already received: 42501 (M-3)', async () => {
    const { data, error } = await manager.client
      .from('purchase_orders')
      .insert({ supplier_id: supplierId, status: 'received', created_by: manager.id })
      .select('id');
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('a client delete on a received PO affects zero rows; the row is still present', async () => {
    const poId = await seedPo('received');
    const { data: deleted, error } = await manager.client.from('purchase_orders').delete().eq('id', poId).select('id');
    expect(error).toBeNull();
    expect(deleted).toHaveLength(0);
    const { data: stillThere } = await db.from('purchase_orders').select('id').eq('id', poId).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it('a client delete on a draft PO succeeds', async () => {
    const poId = await seedPo('draft');
    const { data: deleted, error } = await manager.client.from('purchase_orders').delete().eq('id', poId).select('id');
    expect(error).toBeNull();
    expect(deleted).toHaveLength(1);
    const { data: gone } = await db.from('purchase_orders').select('id').eq('id', poId).maybeSingle();
    expect(gone).toBeNull();
    poIds.splice(poIds.indexOf(poId), 1);
  });

  it('inserting a purchase_order_item under a received PO is denied by RLS: 42501', async () => {
    const poId = await seedPo('received');
    const { error } = await manager.client
      .from('purchase_order_items')
      .insert({ purchase_order_id: poId, product_id: productId, quantity: 1, cost_price: 1 });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('receive_shipment replays an idempotency key: same shipmentId, second call reports idempotent, stock moves once', async () => {
    const key = crypto.randomUUID();
    const { data: before } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    const beforeQty = Number(before?.quantity_on_hand ?? 0);

    const items = [{ product_id: productId, quantity: 4, cost_price: 2 }];
    const first = await db.rpc('receive_shipment', {
      p_staff_id: manager.id,
      p_supplier_id: supplierId,
      p_items: items,
      p_po_id: null,
      p_idempotency_key: key,
    });
    expect(first.error).toBeNull();
    expect(first.data.ok).toBe(true);
    expect(first.data.idempotent).toBeFalsy();
    shipmentIds.push(first.data.shipmentId);

    const second = await db.rpc('receive_shipment', {
      p_staff_id: manager.id,
      p_supplier_id: supplierId,
      p_items: items,
      p_po_id: null,
      p_idempotency_key: key,
    });
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ ok: true, shipmentId: first.data.shipmentId, idempotent: true });

    const { data: after } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    expect(Number(after.quantity_on_hand)).toBe(beforeQty + 4);

    const { data: movements } = await db
      .from('stock_movements')
      .select('id')
      .eq('ref_type', 'shipment')
      .eq('ref_id', first.data.shipmentId)
      .eq('reason', 'delivery');
    expect(movements).toHaveLength(1);
  });

  it('receive_shipment without a key creates two shipments on two calls (documents the transition behaviour)', async () => {
    const items = [{ product_id: productId, quantity: 1, cost_price: 1 }];
    const first = await db.rpc('receive_shipment', { p_staff_id: manager.id, p_supplier_id: supplierId, p_items: items, p_po_id: null });
    expect(first.error).toBeNull();
    expect(first.data.ok).toBe(true);
    shipmentIds.push(first.data.shipmentId);

    const second = await db.rpc('receive_shipment', { p_staff_id: manager.id, p_supplier_id: supplierId, p_items: items, p_po_id: null });
    expect(second.error).toBeNull();
    expect(second.data.ok).toBe(true);
    shipmentIds.push(second.data.shipmentId);

    expect(second.data.shipmentId).not.toBe(first.data.shipmentId);
  });
});

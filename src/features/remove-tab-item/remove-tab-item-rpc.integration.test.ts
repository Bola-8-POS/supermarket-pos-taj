/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: remove_tab_item RPC — active-caller gate on line removal
 * (wave 3a) and the dropped direct-DELETE policy on order_items.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack, edge runtime running for staff-sign-in). Skips gracefully when absent.
 *
 * Run: npx vitest run src/features/remove-tab-item/remove-tab-item-rpc.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__remove_tab_item_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'cashier' | 'kitchen';
  pin: string;
  client: any;
}

describe.skipIf(skip)('remove_tab_item RPC — active-caller gate', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());

  const cashier: Fixture = { id: '', name: `${TAG}cashier`, email: `${TAG}c_${stamp}@test.local`, role: 'cashier', pin: randomPin(), client: null };
  const kitchen: Fixture = { id: '', name: `${TAG}kitchen`, email: `${TAG}k_${stamp}@test.local`, role: 'kitchen', pin: randomPin(), client: null };
  const manager: Fixture = { id: '', name: `${TAG}manager`, email: `${TAG}m_${stamp}@test.local`, role: 'manager', pin: randomPin(), client: null };
  const fixtures = [cashier, kitchen, manager];
  const tabIds: string[] = [];
  let shiftId = '';
  let productId = '';

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

  async function seedTab(status: 'open' | 'paid', quantity: number): Promise<{ tabId: string; itemId: string }> {
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `${TAG}${Date.now()}`,
        staff_id: cashier.id,
        shift_id: shiftId,
        status,
        ...(status === 'paid' ? { closed_at: new Date().toISOString() } : {}),
      })
      .select('id')
      .single();
    if (tabErr || !tab) throw new Error(`tab insert: ${tabErr?.message}`);
    tabIds.push(tab.id);

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tab.id, staff_id: cashier.id, status: status === 'paid' ? 'served' : 'pending' })
      .select('id')
      .single();
    if (orderErr || !order) throw new Error(`order insert: ${orderErr?.message}`);

    const { data: item, error: itemErr } = await db
      .from('order_items')
      .insert({ order_id: order.id, product_id: productId, quantity, unit_price: 5.0, modifier_price_delta: 0 })
      .select('id')
      .single();
    if (itemErr || !item) throw new Error(`item insert: ${itemErr?.message}`);

    return { tabId: tab.id as string, itemId: item.id as string };
  }

  /** Deletes a tab and whatever is left of its order/order_items (the RPC may already have deleted the item). */
  async function cleanupTab(tabId: string): Promise<void> {
    const { data: orders } = await db.from('orders').select('id').eq('tab_id', tabId);
    const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
    if (orderIds.length > 0) await db.from('order_items').delete().in('order_id', orderIds);
    await db.from('orders').delete().eq('tab_id', tabId);
    await db.from('tabs').delete().eq('id', tabId);
    const idx = tabIds.indexOf(tabId);
    if (idx >= 0) tabIds.splice(idx, 1);
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);
    await signIn(cashier);
    await signIn(kitchen);
    await signIn(manager);

    const { data: shift, error: shiftErr } = await db
      .from('shifts')
      .insert({ staff_id: cashier.id, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !shift) throw new Error(`shift insert: ${shiftErr?.message}`);
    shiftId = shift.id as string;

    // Dedicated tagged fixture product (not a shared live catalog product):
    // the RPC restores inventory and writes 'correction' stock_movements
    // rows, so this file creates and owns its own product + inventory row,
    // deleted in afterAll (same pattern as
    // receive-po-shipment.integration.test.ts's IT_PRODUCT_ID).
    const { data: category, error: categoryErr } = await db.from('categories').select('id').limit(1).single();
    if (categoryErr || !category) throw new Error(`no category: ${categoryErr?.message}`);
    const { data: product, error: productErr } = await db
      .from('products')
      .insert({ name: `${TAG}product`, category_id: category.id, base_price: 5, is_active: true, sold_by_weight: false })
      .select('id')
      .single();
    if (productErr || !product) throw new Error(`fixture product insert: ${productErr?.message}`);
    productId = product.id as string;

    const { error: invErr } = await db.from('inventory').insert({ product_id: productId, quantity_on_hand: 100 });
    if (invErr) throw new Error(`fixture inventory insert: ${invErr.message}`);
  });

  afterAll(async () => {
    for (const tabId of [...tabIds]) await cleanupTab(tabId).catch(() => undefined);
    if (shiftId) await db.from('shifts').delete().eq('id', shiftId);

    const movDel = await db.from('stock_movements').delete().eq('product_id', productId);
    expect(movDel.error).toBeNull();
    const invDel = await db.from('inventory').delete().eq('product_id', productId);
    expect(invDel.error).toBeNull();
    const prodDel = await db.from('products').delete().eq('id', productId);
    expect(prodDel.error).toBeNull();

    // Dependents (stock_movements/shifts) cleaned above and inside
    // removeFixture itself — profiles must delete last.
    for (const f of fixtures) await removeFixture(f);
  });

  it('refuses a kitchen session', async () => {
    const { tabId, itemId } = await seedTab('open', 2);
    const { data, error } = await kitchen.client.rpc('remove_tab_item', { p_item_id: itemId, p_reason: 'test' });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/^AUTH_FORBIDDEN/);
    await cleanupTab(tabId);
  });

  it('refuses a deactivated cashier', async () => {
    const { tabId, itemId } = await seedTab('open', 2);
    const { error: deactErr } = await db.rpc('set_staff_active', {
      p_staff_id: cashier.id,
      p_active: false,
      p_actor_id: manager.id,
    });
    expect(deactErr).toBeNull();
    try {
      const { data, error } = await cashier.client.rpc('remove_tab_item', { p_item_id: itemId, p_reason: 'test' });
      expect(data).toBeNull();
      expect(error?.message).toMatch(/^AUTH_FORBIDDEN/);
    } finally {
      await db.rpc('set_staff_active', { p_staff_id: cashier.id, p_active: true, p_actor_id: manager.id });
    }
    await cleanupTab(tabId);
  });

  it('refuses an anonymous client', async () => {
    const { tabId, itemId } = await seedTab('open', 2);
    const { error } = await anon().rpc('remove_tab_item', { p_item_id: itemId, p_reason: 'test' });
    expect(error).not.toBeNull();
    await cleanupTab(tabId);
  });

  it('active cashier removes a line on an open tab: ok, stock restored, movement attributes the cashier', async () => {
    const { tabId, itemId } = await seedTab('open', 3);
    const { data: before } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    const beforeQty = Number(before?.quantity_on_hand ?? 0);

    const { data, error } = await cashier.client.rpc('remove_tab_item', { p_item_id: itemId, p_reason: 'test remove' });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true });

    const { data: after } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    expect(Number(after.quantity_on_hand)).toBe(beforeQty + 3);

    const { data: movement } = await db
      .from('stock_movements')
      .select('staff_id, quantity_delta, reason')
      .eq('product_id', productId)
      .eq('reason', 'correction')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(movement.staff_id).toBe(cashier.id);
    expect(Number(movement.quantity_delta)).toBe(3);

    await cleanupTab(tabId);
  });

  it("a direct client delete on a paid tab's line affects zero rows; the row and stock are unchanged", async () => {
    const { tabId, itemId } = await seedTab('paid', 1);
    const { data: before } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();

    const { data: deleted, error } = await cashier.client.from('order_items').delete().eq('id', itemId).select('id');
    expect(error).toBeNull();
    expect(deleted).toHaveLength(0);

    const { data: stillThere } = await db.from('order_items').select('id').eq('id', itemId).maybeSingle();
    expect(stillThere).not.toBeNull();

    const { data: after } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    expect(Number(after.quantity_on_hand)).toBe(Number(before.quantity_on_hand));

    await cleanupTab(tabId);
  });

  it('active manager on a paid tab line through the RPC: TAB_NOT_OPEN', async () => {
    const { tabId, itemId } = await seedTab('paid', 1);
    const { data, error } = await manager.client.rpc('remove_tab_item', { p_item_id: itemId, p_reason: 'test' });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, code: 'TAB_NOT_OPEN' });
    await cleanupTab(tabId);
  });
});

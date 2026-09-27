/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: settings restore on the local stack with the edge
 * runtime running — the settings-restore edge function plus its backing RPC,
 * `settings_restore_snapshot`.
 *
 * Run: npx vitest run src/entities/settings/model/settings-restore.integration.test.ts
 * Fixture pattern from src/entities/staff/model/staff-lifecycle.integration.test.ts.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__settings_restore_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface StaffFixture {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager';
  pin: string;
}

interface ProductModifierRow {
  product_id: string;
  modifier_id: string;
}

describe.skipIf(skip)('settings restore', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;

  const admin: StaffFixture = { id: '', name: `${TAG}admin`, email: `${TAG}a_${String(Date.now())}@test.local`, role: 'admin', pin: randomPin() };
  const manager: StaffFixture = { id: '', name: `${TAG}manager`, email: `${TAG}m_${String(Date.now())}@test.local`, role: 'manager', pin: randomPin() };
  const staff = [admin, manager];

  let adminToken = '';
  let managerToken = '';
  let categoryId = '';
  let weightProductId = '';
  let newProductId = '';
  // The RPC always deletes every product_modifiers row and reinserts the
  // snapshot's own set (no merge semantics for the link table) — a restore
  // called with an empty product_modifiers array would strip the shared
  // local stack's seed links out from under every other integration/e2e run
  // sharing it. Captured once here, fed back into every committing snapshot
  // below, and re-asserted in afterAll regardless of which test ran last.
  let originalProductModifiers: ProductModifierRow[] = [];
  const backupIds: string[] = [];

  async function callRestore(token: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/settings-restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function makeBackup(label: string, snapshot: Record<string, unknown>): Promise<string> {
    const { data, error } = await db
      .from('settings_backups')
      .insert({ label: `${TAG}${label}`, snapshot, created_by: admin.id })
      .select('id')
      .single();
    if (error || !data) throw new Error(`makeBackup(${label}): ${error?.message}`);
    backupIds.push(data.id as string);
    return data.id as string;
  }

  async function makeStaffFixture(f: StaffFixture): Promise<void> {
    const { data, error } = await db.auth.admin.createUser({ email: f.email, password: f.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user ${f.name}: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db
      .from('profiles')
      .upsert({ id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true, must_change_pin: false });
    if (profileErr) throw new Error(`profile upsert ${f.name}: ${profileErr.message}`);
  }

  async function signIn(f: StaffFixture): Promise<string> {
    const client = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
    const { data, error } = await client.auth.signInWithPassword({ email: f.email, password: f.pin });
    if (error || !data.session) throw new Error(`sign in ${f.name}: ${error?.message}`);
    return data.session.access_token as string;
  }

  beforeAll(async () => {
    for (const f of staff) await makeStaffFixture(f);
    adminToken = await signIn(admin);
    managerToken = await signIn(manager);

    const { data: pmData, error: pmErr } = await db.from('product_modifiers').select('product_id, modifier_id');
    if (pmErr) throw new Error(`capture product_modifiers: ${pmErr.message}`);
    originalProductModifiers = (pmData ?? []) as ProductModifierRow[];

    const { data: category, error: categoryErr } = await db
      .from('categories')
      .insert({ name: `${TAG}category_before`, color: '#123456', sort_order: 0 })
      .select('id')
      .single();
    if (categoryErr || !category) throw new Error(`create category: ${categoryErr?.message}`);
    categoryId = category.id as string;

    const { data: product, error: productErr } = await db
      .from('products')
      .insert({ name: `${TAG}weighted_product`, category_id: categoryId, base_price: 10, sold_by_weight: true })
      .select('id')
      .single();
    if (productErr || !product) throw new Error(`create weighted product: ${productErr?.message}`);
    weightProductId = product.id as string;
  });

  afterAll(async () => {
    // Put product_modifiers back exactly as captured, regardless of
    // which restores ran above.
    const { error: pmDeleteErr } = await db
      .from('product_modifiers')
      .delete()
      .neq('product_id', '00000000-0000-0000-0000-000000000000');
    if (pmDeleteErr) throw new Error(`restore product_modifiers (clear): ${pmDeleteErr.message}`);
    if (originalProductModifiers.length > 0) {
      const { error: pmInsertErr } = await db.from('product_modifiers').insert(originalProductModifiers);
      if (pmInsertErr) throw new Error(`restore product_modifiers (reinsert): ${pmInsertErr.message}`);
    }

    // settings_backups.created_by/restored_by reference profiles(id) with no
    // ON DELETE clause (RESTRICT) — backups must go before the staff fixtures.
    if (backupIds.length > 0) {
      const { error } = await db.from('settings_backups').delete().in('id', backupIds);
      if (error) throw new Error(`delete backups: ${error.message}`);
    }
    // products.category_id REFERENCES categories(id) ON DELETE RESTRICT — the
    // product goes before the category.
    if (weightProductId) {
      const { error } = await db.from('products').delete().eq('id', weightProductId);
      if (error) throw new Error(`delete weighted product: ${error.message}`);
    }
    if (newProductId) {
      const { error } = await db.from('products').delete().eq('id', newProductId);
      if (error) throw new Error(`delete restore-inserted product: ${error.message}`);
    }
    if (categoryId) {
      const { error } = await db.from('categories').delete().eq('id', categoryId);
      if (error) throw new Error(`delete category: ${error.message}`);
    }
    for (const f of staff) {
      if (!f.id) continue;
      const { error: attemptsErr } = await db.from('pin_attempts').delete().like('attempt_key', `%${f.id}%`);
      if (attemptsErr) throw new Error(`pin_attempts cleanup for ${f.name}: ${attemptsErr.message}`);
      const { error: profileErr } = await db.from('profiles').delete().eq('id', f.id);
      if (profileErr) throw new Error(`profile delete for ${f.name}: ${profileErr.message}`);
      const { error: authErr } = await db.auth.admin.deleteUser(f.id);
      if (authErr) throw new Error(`auth user delete for ${f.name}: ${authErr.message}`);
    }
  });

  it('rolls back the whole restore when a products row violates a constraint, leaving a previously-updated category unchanged', async () => {
    const backupId = await makeBackup('bad_product', {
      settings: [],
      categories: [{ id: categoryId, name: `${TAG}category_should_not_apply` }],
      products: [
        {
          id: crypto.randomUUID(),
          name: `${TAG}bad_product`,
          category_id: categoryId,
          base_price: -5, // violates products.base_price_positive
        },
      ],
      modifiers: [],
      product_modifiers: originalProductModifiers,
    });

    const { status, json } = await callRestore(adminToken, { backupId });
    expect(status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('RESTORE_FAILED');

    const { data: categoryRow, error } = await db.from('categories').select('name').eq('id', categoryId).single();
    expect(error).toBeNull();
    expect(categoryRow.name).toBe(`${TAG}category_before`);

    // The whole RPC transaction rolled back, including the backup row's own
    // update — a real rollback, not just the products/categories tables.
    const { data: backupRow, error: backupErr } = await db
      .from('settings_backups')
      .select('restored_at')
      .eq('id', backupId)
      .single();
    expect(backupErr).toBeNull();
    expect(backupRow.restored_at).toBeNull();
  });

  it('restores a valid snapshot and marks the backup restored', async () => {
    const backupId = await makeBackup('valid', {
      settings: [],
      categories: [],
      products: [],
      modifiers: [],
      product_modifiers: originalProductModifiers,
    });

    const { status, json } = await callRestore(adminToken, { backupId });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });

    const { data: backupRow, error } = await db
      .from('settings_backups')
      .select('restored_at, restored_by')
      .eq('id', backupId)
      .single();
    expect(error).toBeNull();
    expect(backupRow.restored_at).not.toBeNull();
    expect(backupRow.restored_by).toBe(admin.id);
  });

  it('restores a product whose snapshot omits sold_by_weight without nulling the live value', async () => {
    const backupId = await makeBackup('sold_by_weight', {
      settings: [],
      categories: [],
      // Deliberately no `sold_by_weight` key — mirrors an older backup taken
      // before that column existed.
      products: [{ id: weightProductId }],
      modifiers: [],
      product_modifiers: originalProductModifiers,
    });

    const { status, json } = await callRestore(adminToken, { backupId });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });

    const { data: productRow, error } = await db
      .from('products')
      .select('sold_by_weight')
      .eq('id', weightProductId)
      .single();
    expect(error).toBeNull();
    expect(productRow.sold_by_weight).toBe(true);
  });

  it('inserts a new-id product whose snapshot omits sold_by_weight with the column default, not null', async () => {
    newProductId = crypto.randomUUID();
    const backupId = await makeBackup('new_id_default', {
      settings: [],
      categories: [],
      // No `sold_by_weight` key and this id does not exist yet — the merge
      // has no existing row to fall back to, so it must use the column's
      // own catalog default (false) rather than leaving it null.
      products: [
        { id: newProductId, name: `${TAG}new_product`, category_id: categoryId, base_price: 5 },
      ],
      modifiers: [],
      product_modifiers: originalProductModifiers,
    });

    const { status, json } = await callRestore(adminToken, { backupId });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });

    const { data: productRow, error } = await db
      .from('products')
      .select('sold_by_weight')
      .eq('id', newProductId)
      .single();
    expect(error).toBeNull();
    expect(productRow.sold_by_weight).toBe(false);
  });

  it('refuses a manager with 403 FORBIDDEN', async () => {
    const { status, json } = await callRestore(managerToken, { backupId: crypto.randomUUID() });
    expect(status).toBe(403);
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('FORBIDDEN');
  });
});

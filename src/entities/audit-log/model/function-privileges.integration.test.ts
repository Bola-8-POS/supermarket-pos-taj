/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: function privileges and audit payloads.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack). Skips gracefully when they are absent.
 *
 * Run: npx vitest run src/entities/audit-log/model/function-privileges.integration.test.ts --project integration
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__fn_privileges_test__';
const PASSWORD = `Tp-${crypto.randomUUID()}`;
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface TestUser {
  id: string;
  email: string;
  client: any;
}

describe.skipIf(skip)('function privileges and audit payloads', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const signedOut = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const userA: TestUser = { id: '', email: `${TAG}a_${stamp}@test.local`, client: null };
  const userB: TestUser = { id: '', email: `${TAG}b_${stamp}@test.local`, client: null };

  async function makeUser(u: TestUser): Promise<void> {
    const { data, error } = await db.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    u.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: u.id,
      name: TAG,
      email: u.email,
      role: 'manager',
      pin: randomPin(),
      is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: signInErr } = await u.client.auth.signInWithPassword({
      email: u.email,
      password: PASSWORD,
    });
    if (signInErr) throw new Error(`sign in: ${signInErr.message}`);
  }

  async function removeUser(u: TestUser): Promise<void> {
    if (!u.id) return;
    await db.from('profiles').delete().eq('id', u.id);
    await db.auth.admin.deleteUser(u.id);
  }

  beforeAll(async () => {
    await makeUser(userA);
    await makeUser(userB);
  });

  afterAll(async () => {
    await db.from('audit_logs').delete().eq('action', TAG);
    await db.from('audit_logs').delete().eq('terminal_id', TAG);
    await removeUser(userA);
    await removeUser(userB);
  });

  it('refuses callers without a session', async () => {
    const someId = crypto.randomUUID();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['record_audit', { p_action: TAG, p_entity_type: 'test_entity' }],
      ['list_caja_sessions', { p_limit: 1 }],
      ['get_caja_report', { p_caja_id: someId }],
      ['remove_tab_item', { p_item_id: someId, p_reason: TAG }],
      [
        'consume_open_unit',
        { p_product_id: someId, p_qty: 1, p_order_item_id: someId, p_direction: 1, p_allow_negative: false },
      ],
      ['set_own_locale', { p_locale: 'es-MX' }],
      ['get_product_sales_report', { p_from: '2026-01-01T00:00:00Z', p_to: '2026-01-02T00:00:00Z' }],
      ['process_refund', { p_original_payment_id: someId, p_items: [], p_reason: TAG, p_approval_id: null }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await signedOut.rpc(fn, args);
      expect(error?.code, `${fn} should be refused without a session`).toBe('42501');
    }
  });

  it('refuses direct calls to the checkout RPCs from a signed-in session', async () => {
    const { error } = await userA.client.rpc('process_payment_atomic', {
      p_tab_id: crypto.randomUUID(),
      p_staff_id: userA.id,
      p_amount: 1,
      p_method: 'cash',
      p_idempotency_key: `${TAG}${stamp}`,
    });
    expect(error?.code).toBe('42501');
  });

  it('records the signed-in caller as the actor even when another actor is named', async () => {
    const { data: logId, error } = await userA.client.rpc('record_audit', {
      p_action: TAG,
      p_entity_type: 'test_entity',
      p_user_id: userB.id,
    });
    expect(error).toBeNull();
    const { data: row } = await db.from('audit_logs').select('actor_id').eq('id', logId).single();
    expect(row.actor_id).toBe(userA.id);
  });

  it('lets the service role name the actor', async () => {
    const { data: logId, error } = await db.rpc('record_audit', {
      p_action: TAG,
      p_entity_type: 'test_entity',
      p_user_id: userB.id,
    });
    expect(error).toBeNull();
    const { data: row } = await db.from('audit_logs').select('actor_id').eq('id', logId).single();
    expect(row.actor_id).toBe(userB.id);
  });

  it('removes pin keys from payloads passed to record_audit', async () => {
    const { data: logId, error } = await userA.client.rpc('record_audit', {
      p_action: TAG,
      p_entity_type: 'test_entity',
      p_after: { pin: 'x', nested: { new_pin: 'y', keep: 1 }, list: [{ old_pin: 'z', ok: true }] },
    });
    expect(error).toBeNull();
    const { data: row } = await db.from('audit_logs').select('after').eq('id', logId).single();
    expect(row.after).toEqual({ nested: { keep: 1 }, list: [{ ok: true }] });
  });

  it('keeps pin and email out of the locale-change audit payload', async () => {
    const { error } = await userA.client.rpc('set_own_locale', { p_locale: 'en-US', p_terminal_id: TAG });
    expect(error).toBeNull();
    const { data: rows } = await db
      .from('audit_logs')
      .select('before, after')
      .eq('action', 'staff.locale_change')
      .eq('entity_id', userA.id)
      .eq('terminal_id', TAG);
    expect(rows).toHaveLength(1);
    for (const key of ['before', 'after'] as const) {
      const payload = rows[0][key];
      expect(payload).toBeTruthy();
      expect(payload).not.toHaveProperty('pin');
      expect(payload).not.toHaveProperty('email');
      expect(payload.id).toBe(userA.id);
    }
  });
});

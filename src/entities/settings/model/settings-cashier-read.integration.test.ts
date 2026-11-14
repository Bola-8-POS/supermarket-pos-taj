/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { unusedPin as unusedPinFor } from '../../../test/pin-helpers';

/**
 * Integration test: can a signed-in CASHIER read the settings rows the till prices with?
 * The till builds its pricing snapshot from `settings` (general / billing / near_expiry); the
 * server prices with the stored values. A cashier read that returns nothing means the till
 * prices on built-in defaults.
 *
 * Run: npx vitest run src/entities/settings/model/settings-cashier-read.integration.test.ts --project integration
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('settings read by a cashier session (integration)', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const email = `__settings_cashier_read_${stamp}@test.local`;
  let id = '';
  let client: any;

  beforeAll(async () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
    const pin = await unusedPinFor(db);
    const newId = randomUUID();
    const { data, error } = await db.auth.admin.createUser({
      id: newId, email, password: await deriveStaffPassword(newId, pin), email_confirm: true,
    });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    id = data.user.id as string;
    const { error: pErr } = await db.from('profiles').upsert({
      id, name: '__settings_cashier_read__', email, role: 'cashier', pin, is_active: true,
    });
    if (pErr) throw new Error(`profile upsert: ${pErr.message}`);
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${anonKey!}` },
      body: JSON.stringify({ staffId: id, pin }),
    });
    const json: any = await res.json().catch(() => null);
    if (res.status !== 200) throw new Error(`sign in: ${res.status}`);
    client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: sErr } = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (sErr) throw new Error(`setSession: ${sErr.message}`);
  });

  afterAll(async () => {
    if (!id) return;
    await db.from('pin_attempts').delete().like('attempt_key', `%${id}%`);
    await db.from('profiles').delete().eq('id', id);
    await db.auth.admin.deleteUser(id);
  });

  it('a cashier session reads settings.general.timezone, near_expiry and billing as stored', async () => {
    const keys = ['general', 'billing', 'near_expiry'];
    const { data: stored, error: sErr } = await db.from('settings').select('key, value').in('key', keys);
    expect(sErr).toBeNull();
    expect((stored ?? []).map((r: any) => r.key).sort()).toEqual(['billing', 'general', 'near_expiry']);

    const { data, error } = await client.from('settings').select('key, value').in('key', keys);
    expect(error).toBeNull();
    const byKey = new Map((data ?? []).map((r: any) => [r.key, r.value]));
    for (const row of stored as any[]) {
      expect(byKey.get(row.key), `cashier read of settings.${row.key}`).toEqual(row.value);
    }
  });

  const PRICING = ['general', 'billing', 'near_expiry'];

  it('a cashier session cannot read any other settings key', async () => {
    const { data: existing } = await db.from('settings').select('key').eq('key', 'email_receipts');
    const created = (existing ?? []).length === 0;
    try {
      if (created) {
        const { error } = await db
          .from('settings')
          .upsert({ key: 'email_receipts', value: { fromEmail: 'x@test.local' } });
        expect(error).toBeNull();
      }
      const { data: all, error } = await client.from('settings').select('key');
      expect(error).toBeNull();
      for (const row of all ?? []) expect(PRICING).toContain(row.key);
      const { data: other } = await client.from('settings').select('key').eq('key', 'email_receipts');
      expect(other).toEqual([]);
      const { data: seen } = await db.from('settings').select('key').eq('key', 'email_receipts');
      expect(seen).toHaveLength(1);
    } finally {
      if (created) await db.from('settings').delete().eq('key', 'email_receipts');
    }
  });

  it('a cashier session cannot update a pricing settings row', async () => {
    const before = await db.from('settings').select('value').eq('key', 'billing').single();
    const { data } = await client
      .from('settings')
      .update({ value: { taxInclusive: false, taxRatePercent: 99 } })
      .eq('key', 'billing')
      .select();
    expect(data).toEqual([]);
    const after = await db.from('settings').select('value').eq('key', 'billing').single();
    expect(after.data.value).toEqual(before.data.value);
  });

  it('a cashier session cannot insert a settings row', async () => {
    const key = `__cashier_probe_${stamp}`;
    try {
      const { error } = await client.from('settings').insert({ key, value: {} });
      expect(error?.code).toBe('42501');
      const { data } = await db.from('settings').select('key').eq('key', key);
      expect(data).toEqual([]);
    } finally {
      await db.from('settings').delete().eq('key', key);
    }
  });

  it('a cashier session cannot delete a pricing settings row', async () => {
    const { data } = await client.from('settings').delete().eq('key', 'near_expiry').select();
    expect(data).toEqual([]);
    const { data: still } = await db.from('settings').select('key').eq('key', 'near_expiry');
    expect(still).toHaveLength(1);
  });
});

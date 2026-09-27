/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: profile privileges on the local stack (column grants on
 * profiles, the retired PIN-change RPC, the attempt limit on the PIN holder
 * lookup) with the edge runtime running.
 *
 * Run: npx vitest run src/entities/staff/model/profile-privileges.integration.test.ts --project integration
 * Note: the local Auth service allows 30 sign-ins per 5 minutes per address;
 * this file performs two.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__profile_privileges_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'cashier';
  pin: string;
  client: any;
}

describe.skipIf(skip)('profile privileges', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const cashier: Fixture = { id: '', name: `${TAG}cashier`, email: `${TAG}c_${stamp}@test.local`, role: 'cashier', pin: randomPin(), client: null };
  // The admin's lookup budget is spent only by the last case, so it must stay untouched before that.
  const admin: Fixture = { id: '', name: `${TAG}admin`, email: `${TAG}a_${stamp}@test.local`, role: 'admin', pin: randomPin(), client: null };
  const fixtures = [cashier, admin];

  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;

  async function signIn(f: Fixture): Promise<any> {
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ staffId: f.id, pin: f.pin }),
    });
    if (res.status !== 200) throw new Error(`sign in for ${f.name}: ${res.status}`);
    const json = await res.json();
    const client = anon();
    const { error } = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (error) throw new Error(`setSession: ${error.message}`);
    return client;
  }

  async function makeFixture(f: Fixture): Promise<void> {
    // The Auth password equals the PIN, as create-staff sets it.
    const { data, error } = await db.auth.admin.createUser({ email: f.email, password: f.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true, must_change_pin: false, locale: 'es-MX',
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    f.client = await signIn(f);
  }

  async function removeFixture(f: Fixture): Promise<void> {
    if (!f.id) return;
    const { error: attemptsErr } = await db.from('pin_attempts').delete().like('attempt_key', `%${f.id}%`);
    expect(attemptsErr, `pin_attempts cleanup for ${f.name}`).toBeNull();
    const { error: ticketsErr } = await db.from('manager_approvals').delete().eq('caller_id', f.id);
    expect(ticketsErr, `manager_approvals cleanup for ${f.name}`).toBeNull();
    const { error: profileErr } = await db.from('profiles').delete().eq('id', f.id);
    expect(profileErr, `profile delete for ${f.name}`).toBeNull();
    const { error: authErr } = await db.auth.admin.deleteUser(f.id);
    expect(authErr, `auth user delete for ${f.name}`).toBeNull();
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);
  });

  afterAll(async () => {
    for (const f of fixtures) await removeFixture(f);
    const { count, error } = await db.from('profiles').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('serves the sign-in list to anon but not the profiles table', async () => {
    const { data: directory, error: directoryErr } = await anon().from('staff_directory').select('id').in('id', [cashier.id, admin.id]);
    expect(directoryErr).toBeNull();
    expect(directory).toHaveLength(2);

    const { error } = await anon().from('profiles').select('id').limit(1);
    expect(error?.code).toBe('42501');
  });

  it('lets a signed-in cashier read the listed columns only', async () => {
    const { data, error } = await cashier.client.from('profiles').select('id, name').eq('id', cashier.id);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: cashier.id, name: cashier.name }]);

    const { error: pinErr } = await cashier.client.from('profiles').select('pin').eq('id', cashier.id);
    expect(pinErr?.code).toBe('42501');

    const { error: allErr } = await cashier.client.from('profiles').select('*').eq('id', cashier.id);
    expect(allErr?.code).toBe('42501');
  });

  it('lets an admin update locale but not the PIN', async () => {
    const { data, error } = await admin.client.from('profiles').update({ locale: 'en-US' }).eq('id', cashier.id).select('id, locale');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: cashier.id, locale: 'en-US' }]);

    const { error: pinErr } = await admin.client.from('profiles').update({ pin: randomPin() }).eq('id', cashier.id);
    expect(pinErr?.code).toBe('42501');
    const { data: kept } = await db.from('profiles').select('pin').eq('id', cashier.id).single();
    expect(kept.pin).toBe(cashier.pin);
  });

  it('no longer exposes the retired PIN-change RPC', async () => {
    const { error } = await cashier.client.rpc('clear_must_change_pin', { p_new_pin: randomPin() });
    expect(error?.code).toBe('PGRST202');
  });

  it('limits the PIN holder lookup to its own attempt budget', async () => {
    for (let i = 0; i < 5; i++) {
      const { error } = await admin.client.rpc('staff_pin_holder', { p_pin: cashier.pin, p_exclude_staff_id: null });
      expect(error, `lookup ${i + 1}`).toBeNull();
    }
    const { error } = await admin.client.rpc('staff_pin_holder', { p_pin: cashier.pin, p_exclude_staff_id: null });
    expect(error).not.toBeNull();
    expect(error.message.startsWith('PIN_LOCKED')).toBe(true);

    // The lookup's key is its own: the manager prompt still answers the same admin.
    const { data: prompt, error: promptErr } = await admin.client.rpc('verify_staff_pin', { p_pin: admin.pin, p_staff_id: admin.id, p_required_action: null });
    expect(promptErr).toBeNull();
    expect(prompt.ok).toBe(true);
  });
});

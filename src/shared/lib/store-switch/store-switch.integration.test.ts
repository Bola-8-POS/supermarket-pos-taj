/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: the public status view and the till report RPC through PostgREST on dev2.
 * dev2 is shared, so this only READS the state (it is `active`) and writes one tagged report row.
 * Run: npx vitest run --project integration src/shared/lib/store-switch/store-switch.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;
// A skip must be visible: a run that silently reports zero tests looks like a pass.
if (skip) {
  console.warn(
    `[store-switch.integration] SKIPPED: missing ${[
      !url && 'VITE_SUPABASE_URL',
      !anonKey && 'VITE_SUPABASE_ANON_KEY',
      !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ]
      .filter(Boolean)
      .join(', ')} (set them in .env.local)`,
  );
} else {
  console.info(`[store-switch.integration] target port ${new URL(url!).port}`);
}
const TAG = '__store_switch_test__';
const PASSWORD = `Tp-${crypto.randomUUID()}`;
const TERMINAL = crypto.randomUUID();

describe.skipIf(skip)('store switch status view and report_till_sync', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const signedIn = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const email = `${TAG}${Date.now()}@test.local`;
  let userId = '';

  beforeAll(async () => {
    // dev2 is 56321; the selfhosted stack (54321) must never be touched by a test.
    if (new URL(url!).port === '54321') throw new Error('refusing to run against the selfhosted stack (54321)');
    const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    userId = data.user.id as string;
    const { error: signInErr } = await signedIn.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInErr) throw new Error(`sign in: ${signInErr.message}`);
  });

  afterAll(async () => {
    await db.from('till_sync_report').delete().eq('terminal_uuid', TERMINAL);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  // Proves the file really executes when the env is present (a skip would report zero tests).
  it('targets dev2 (port 56321) with all three clients created', () => {
    expect(new URL(url!).port).toBe('56321');
    expect([db, anon, signedIn].every(Boolean)).toBe(true);
    console.info(`[store-switch.integration] executing against port ${new URL(url!).port}`);
  });

  it('anon reads the effective state through the view', async () => {
    const { data, error } = await anon.from('store_switch_status').select('state').maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ state: 'active' });
  });

  it('a signed-in caller reads the effective state through the view', async () => {
    const { data, error } = await signedIn.from('store_switch_status').select('state').maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ state: 'active' });
  });

  it('anon cannot read the table or report', async () => {
    const t = await anon.from('store_switch_state').select('*');
    expect(t.error).not.toBeNull();
    const r = await anon.rpc('report_till_sync', { p_terminal_uuid: TERMINAL, p_terminal_label: 'POS-9', p_queue_depth: 0, p_dead_letter_depth: 0, p_seen_state: 'active', p_app_version: '1' });
    expect(r.error).not.toBeNull();
  });

  it('a signed-in caller reports, gets the state back, and a second report updates the same row', async () => {
    const args = (depth: number) => ({ p_terminal_uuid: TERMINAL, p_terminal_label: 'POS-9', p_queue_depth: depth, p_dead_letter_depth: 0, p_seen_state: 'active', p_app_version: '1.2.3' });
    const first = await signedIn.rpc('report_till_sync', args(3));
    expect(first.error).toBeNull();
    expect(first.data).toBe('active');
    const second = await signedIn.rpc('report_till_sync', args(0));
    expect(second.error).toBeNull();
    const { data } = await db.from('till_sync_report').select('queue_depth, terminal_label').eq('terminal_uuid', TERMINAL);
    expect(data).toEqual([{ queue_depth: 0, terminal_label: 'POS-9' }]);
  });

  it('rejects an invalid label', async () => {
    const r = await signedIn.rpc('report_till_sync', { p_terminal_uuid: TERMINAL, p_terminal_label: 'bad label', p_queue_depth: 0, p_dead_letter_depth: 0, p_seen_state: 'active', p_app_version: '1' });
    expect(r.error?.message).toContain('VALIDATION_ERROR');
  });
});

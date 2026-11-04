// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { FIXTURE_ACCOUNTS, fixturePin, haveFixturePins } from '../../../test/fixture-accounts';

const RPC = 'unit_test_rpc';
const STAFF_A = FIXTURE_ACCOUNTS.manager.id;
const STAFF_B = FIXTURE_ACCOUNTS.cashier.id;
const KEY = 'idem_test_20260929_aaaa';

async function begin(key: string, staff: string, scope: string) {
  return testDb.rpc('idempotency_begin', {
    p_key: key,
    p_rpc: RPC,
    p_staff: staff,
    p_scope: scope,
  });
}

describe.skipIf(!haveFixturePins())('rpc_idempotency ledger', () => {
  beforeAll(async () => {
    await testDb.from('rpc_idempotency').delete().like('idempotency_key', 'idem_test_%');
  });
  afterAll(async () => {
    await testDb.from('rpc_idempotency').delete().like('idempotency_key', 'idem_test_%');
  });

  it('returns null on first call, then the stored result on replay', async () => {
    const first = await begin(KEY, STAFF_A, 'scope-1');
    expect(first.error).toBeNull();
    expect(first.data).toBeNull();

    const committed = await testDb.rpc('idempotency_commit', {
      p_key: KEY,
      p_rpc: RPC,
      p_staff: STAFF_A,
      p_scope: 'scope-1',
      p_result: { ok: true, value: 42 },
    });
    expect(committed.error).toBeNull();

    const replay = await begin(KEY, STAFF_A, 'scope-1');
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ ok: true, value: 42 });
  });

  it('rejects a replay from a different staff member', async () => {
    const res = await begin(KEY, STAFF_B, 'scope-1');
    expect(res.error?.message ?? '').toContain('IDEMPOTENCY_UNAUTHORIZED');
  });

  it('rejects a replay with different arguments', async () => {
    const res = await begin(KEY, STAFF_A, 'scope-CHANGED');
    expect(res.error?.message ?? '').toContain('IDEMPOTENCY_MISMATCH');
  });

  it('rejects a blank or over-long key', async () => {
    const blank = await begin('   ', STAFF_A, 'scope-1');
    expect(blank.error?.message ?? '').toContain('IDEMPOTENCY_KEY_INVALID');
    const tooLong = await begin(`idem_test_${'x'.repeat(300)}`, STAFF_A, 'scope-1');
    expect(tooLong.error?.message ?? '').toContain('IDEMPOTENCY_KEY_INVALID');
  });

  it('resolves a concurrent double-commit to one stored row', async () => {
    const raceKey = 'idem_test_20260929_race';
    const payload = {
      p_key: raceKey,
      p_rpc: RPC,
      p_staff: STAFF_A,
      p_scope: 'scope-race',
      p_result: { ok: true, winner: 'either' },
    };
    const [a, b] = await Promise.all([
      testDb.rpc('idempotency_commit', payload),
      testDb.rpc('idempotency_commit', payload),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const rows = await testDb.from('rpc_idempotency').select('idempotency_key').eq('idempotency_key', raceKey);
    expect(rows.data).toHaveLength(1);
  });
});

/**
 * Opus re-review task 1 (Important): idempotency_begin/idempotency_commit are SECURITY
 * DEFINER helpers meant to be reachable only through the five adopting RPCs (which run as
 * their owner). Schema-public default privileges grant EXECUTE to `authenticated` on every
 * new function unless a migration revokes it — 20260929000001 revoked from PUBLIC only, not
 * from `authenticated`, so any signed-in staff member could call either helper directly with
 * an arbitrary p_staff and plant/read/overwrite another staff member's ledger row. Fixed by
 * supabase/migrations/20260929000006_revoke_idempotency_helper_access.sql.
 */
describe.skipIf(!haveFixturePins())('rpc_idempotency helper access control', () => {
  beforeAll(async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: FIXTURE_ACCOUNTS.cashier.email,
      password: fixturePin('cashier'),
    });
    if (error) throw new Error(`sign in as cashier fixture: ${error.message}`);
  });

  afterAll(async () => {
    await supabase.auth.signOut();
  });

  it('refuses a signed-in cashier calling idempotency_begin directly', async () => {
    const { error } = await supabase.rpc('idempotency_begin', {
      p_key: 'idem_test_20260929_direct_begin',
      p_rpc: RPC,
      p_staff: STAFF_B,
      p_scope: 'scope-1',
    });
    expect(error?.code).toBe('42501');
  });

  it('refuses a signed-in cashier calling idempotency_commit directly', async () => {
    const { error } = await supabase.rpc('idempotency_commit', {
      p_key: 'idem_test_20260929_direct_commit',
      p_rpc: RPC,
      p_staff: STAFF_B,
      p_scope: 'scope-1',
      p_result: { ok: true },
    });
    expect(error?.code).toBe('42501');
  });

  it('never exposes rpc_idempotency rows to a direct select', async () => {
    // RLS is enabled with no policy, so a SELECT with table-level privilege is filtered to
    // zero rows rather than erroring; once the table GRANT is also revoked (this fix), the
    // same call instead fails at the privilege check. Either layer is an acceptable outcome
    // — the row must never be visible.
    const { data, error } = await supabase.from('rpc_idempotency').select('idempotency_key').limit(1);
    if (error) {
      expect(error.code).toBe('42501');
    } else {
      expect(data).toEqual([]);
    }
  });

  it('refuses a signed-in cashier inserting into rpc_idempotency directly', async () => {
    const { error } = await supabase.from('rpc_idempotency').insert({
      idempotency_key: 'idem_test_20260929_direct_insert',
      rpc_name: RPC,
      staff_id: STAFF_B,
      scope_hash: 'x'.repeat(64),
      result: { ok: true },
    });
    expect(error?.code).toBe('42501');
  });
});

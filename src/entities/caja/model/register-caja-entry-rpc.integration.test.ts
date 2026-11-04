// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: register_caja_entry replay safety + authorization parity
 * (offline-first Plan 01, Task 4). A byte-identical replay of a manual cash
 * in/out call previously created a second, fully independent caja_entries
 * row with nothing in the schema to catch it (recon R2 §B6) — the old client
 * mutation was a bare `.from('caja_entries').insert(...)`, not an RPC.
 *
 * Also proves authorization parity with the caja_entries_insert_manager_admin
 * RLS policy this SECURITY DEFINER RPC bypasses: a cashier (who has no
 * 'manage_caja' row in role_permissions) must be rejected the same way RLS
 * would have rejected their direct insert, and must never observe the
 * idempotency ledger before that rejection.
 *
 * Deviations from the task brief's illustrative test code (documented here,
 * the file the deviation lives in, per constraints.md's deviation policy):
 *  - The brief's p_type values ('cash_in'/'cash_out') don't match the real
 *    caja_entries_type_check constraint (confirmed via `\d caja_entries` on
 *    dev2: 'expense'/'income') — every call below uses 'expense'.
 *  - Uses the self-provisioning fixture-account pattern (FIXTURE_ACCOUNTS /
 *    testDb / haveFixturePins), not the brief's ad hoc admin.createUser +
 *    signInWithPassword block — this mirrors 515059d6's fix applied to the
 *    other Task 2/3 integration tests in this same plan.
 *
 * Run: npx vitest run --project integration src/entities/caja/model/register-caja-entry-rpc.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { FIXTURE_ACCOUNTS, fixturePin, haveFixturePins } from '../../../test/fixture-accounts';

function idKey(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2, 9)}`;
}

// register_caja_entry's supabase.types.ts Returns type is the generic `Json` (jsonb has no
// narrower typed shape) — cast each RPC response to this shape rather than the file-wide
// `createClient(...) as any` other Task 2/3 integration tests use, since this file exercises
// the real typed `supabase` client (not a raw service-role client) end to end.
type RpcResult = { ok: boolean; entryId?: string; idempotent?: boolean };

interface SeededCaja {
  id: string;
  terminalId: string;
}

/** Opens a fresh, uniquely-terminaled caja session for the manager fixture so this file
 * never collides with another integration test's own open caja session. */
async function seedOpenCaja(): Promise<SeededCaja> {
  const terminalId = `IT-RCE-${String(Date.now())}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
  const { data, error } = await testDb
    .from('caja_sessions')
    .insert({ opened_by: FIXTURE_ACCOUNTS.manager.id, opening_cash: 0, terminal_id: terminalId })
    .select('id')
    .single();
  if (error) throw new Error(`seedOpenCaja: ${error.message}`);
  return { id: data.id, terminalId };
}

/** caja_sessions carries the same bump_version_on_update trigger as tabs (STALE_VERSION
 * unless new.version = old.version + 1) — read the current version first so a close
 * actually lands, rather than silently rejecting (reopen-tab-rpc.integration.test.ts's
 * closeCaja precedent). */
async function closeCaja(id: string): Promise<void> {
  const { data } = await testDb.from('caja_sessions').select('version').eq('id', id).single();
  const version = (data?.version ?? 0) + 1;
  const { error } = await testDb
    .from('caja_sessions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      closed_by: FIXTURE_ACCOUNTS.manager.id,
      closing_cash: 0,
      version,
    })
    .eq('id', id);
  if (error) throw new Error(`closeCaja: ${error.message}`);
}

/** Same as seedOpenCaja, but closed immediately — for the CAJA_CLOSED guard test. */
async function seedClosedCaja(): Promise<SeededCaja> {
  const seeded = await seedOpenCaja();
  await closeCaja(seeded.id);
  return seeded;
}

describe.skipIf(!haveFixturePins())('register_caja_entry RPC (integration)', () => {
  const openCajaIds: string[] = [];
  const entryIdsToClean: string[] = [];

  beforeAll(async () => {
    await supabase.auth.signInWithPassword({
      email: FIXTURE_ACCOUNTS.manager.email,
      password: fixturePin('manager'),
    });
  });

  afterEach(async () => {
    while (entryIdsToClean.length > 0) {
      const id = entryIdsToClean.pop();
      if (id) await testDb.from('caja_entries').delete().eq('id', id);
    }
    while (openCajaIds.length > 0) {
      const id = openCajaIds.pop();
      if (id) await closeCaja(id);
    }
  });

  it('a replayed cash-in creates exactly one caja entry', async () => {
    const caja = await seedOpenCaja();
    openCajaIds.push(caja.id);
    const key = idKey('idem_test_caja');
    const args = {
      p_caja_session_id: caja.id,
      p_type: 'expense',
      p_amount: 250,
      p_concept: 'integration test replay',
      p_idempotency_key: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind register_caja_entry's real signature (repo-wide cast pattern)
    } as any;

    const first = await supabase.rpc('register_caja_entry', args);
    expect(first.error).toBeNull();
    const firstData = first.data as RpcResult;
    expect(firstData.ok).toBe(true);
    expect(firstData.entryId).toBeTruthy();
    entryIdsToClean.push(firstData.entryId as string);

    const replay = await supabase.rpc('register_caja_entry', args);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ ok: true, idempotent: true, entryId: firstData.entryId });

    const rows = await testDb
      .from('caja_entries')
      .select('id')
      .eq('caja_session_id', caja.id)
      .eq('concept', 'integration test replay');
    expect(rows.data).toHaveLength(1);
  });

  it('two concurrent replays of the same key do not double-insert', async () => {
    const caja = await seedOpenCaja();
    openCajaIds.push(caja.id);
    const key = idKey('idem_test_caja_concurrent');
    const args = {
      p_caja_session_id: caja.id,
      p_type: 'expense',
      p_amount: 75,
      p_concept: 'integration test concurrent replay',
      p_idempotency_key: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind register_caja_entry's real signature (repo-wide cast pattern)
    } as any;

    const [a, b] = await Promise.all([
      supabase.rpc('register_caja_entry', args),
      supabase.rpc('register_caja_entry', args),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const aData = a.data as RpcResult;
    const bData = b.data as RpcResult;
    expect(aData.ok).toBe(true);
    expect(bData.ok).toBe(true);
    expect(aData.entryId).toBe(bData.entryId);
    entryIdsToClean.push(aData.entryId as string);

    const rows = await testDb
      .from('caja_entries')
      .select('id')
      .eq('caja_session_id', caja.id)
      .eq('concept', 'integration test concurrent replay');
    expect(rows.data).toHaveLength(1);
  });

  it('rejects an entry against a closed caja session', async () => {
    const caja = await seedClosedCaja();
    const res = await supabase.rpc('register_caja_entry', {
      p_caja_session_id: caja.id,
      p_type: 'expense',
      p_amount: 10,
      p_concept: 'integration test closed caja',
      p_idempotency_key: idKey('idem_test_caja_closed'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind register_caja_entry's real signature (repo-wide cast pattern)
    } as any);
    expect(res.error?.message ?? '').toContain('CAJA_CLOSED');
  });

  // ── Authorization parity with caja_entries_insert_manager_admin ───────────
  // A cashier holds no 'manage_caja' row in role_permissions (default seed:
  // only manager/admin do) — the RLS policy this SECURITY DEFINER RPC
  // bypasses would have rejected a direct insert from this caller, so the
  // RPC's own explicit check must reject it identically.

  describe('authorization parity', () => {
    afterEach(async () => {
      await supabase.auth.signOut().catch(() => undefined);
      await supabase.auth.signInWithPassword({
        email: FIXTURE_ACCOUNTS.manager.email,
        password: fixturePin('manager'),
      });
    });

    it('AUTH_FORBIDDEN is returned for a cashier caller, who lacks manage_caja, and no ledger row is written', async () => {
      const caja = await seedOpenCaja();
      openCajaIds.push(caja.id);

      await supabase.auth.signOut();
      await supabase.auth.signInWithPassword({
        email: FIXTURE_ACCOUNTS.cashier.email,
        password: fixturePin('cashier'),
      });

      const key = idKey('idem_test_caja_forbidden');
      const res = await supabase.rpc('register_caja_entry', {
        p_caja_session_id: caja.id,
        p_type: 'expense',
        p_amount: 10,
        p_concept: 'integration test cashier forbidden',
        p_idempotency_key: key,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind register_caja_entry's real signature (repo-wide cast pattern)
      } as any);

      expect(res.error?.message ?? '').toContain('AUTH_FORBIDDEN');

      const rows = await testDb.from('caja_entries').select('id').eq('caja_session_id', caja.id);
      expect(rows.data).toHaveLength(0);

      // The rejection must happen BEFORE the idempotency ledger is ever
      // touched (controller ruling #2) — no ledger row exists for this key,
      // so a later retry (even by an authorized caller) is free to use it
      // fresh rather than tripping IDEMPOTENCY_UNAUTHORIZED.
      const ledgerRows = await testDb.from('rpc_idempotency').select('idempotency_key').eq('idempotency_key', key);
      expect(ledgerRows.data).toHaveLength(0);
    });
  });
});

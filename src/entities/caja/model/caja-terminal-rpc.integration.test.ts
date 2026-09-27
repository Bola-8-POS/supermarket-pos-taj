/* eslint-disable */
// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: caja per terminal (schema + caja_open + process_direct_sale_atomic
 * terminal guard). Migration: 20260913000000_caja_per_terminal.sql.
 *
 * Uses the service-role client directly (bypassing RLS/edge functions) — same
 * pattern as promotion-rpc.integration.test.ts.
 *
 * Run: npx vitest run src/entities/caja/model/caja-terminal-rpc.integration.test.ts --project integration
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDb as db } from '@shared/lib/supabase-test-client';

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

const itPlain = hasEnv ? it : it.skip;

// Fixed fixture staff id (Jamie Chen, manager) from scripts/setup-test-fixtures.ts.
const MANAGER_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// ponytail: scoped to this test's own terminal ids only — a DB-wide sweep
// would close open caja sessions other integration test files (reopen-tab,
// edit-paid-tab) are relying on, since Vitest runs test files concurrently
// against the same shared local Supabase instance.
async function closeAllOpen(): Promise<void> {
  const { data } = await db
    .from('caja_sessions')
    .select('id, version')
    .eq('status', 'open')
    .in('terminal_id', ['POS-1', 'POS-2']);
  for (const row of data ?? []) {
    await db
      .from('caja_sessions')
      .update({ status: 'closed', closed_at: new Date().toISOString(), version: row.version + 1 })
      .eq('id', row.id)
      .eq('version', row.version);
  }
}

describe('caja per terminal (schema + RPC)', () => {
  beforeAll(closeAllOpen);
  afterAll(closeAllOpen);

  itPlain('allows one open caja per terminal and rejects a second on the same terminal', async () => {
    const a = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 100, terminal_id: 'POS-1' } as never)
      .select('id, terminal_id')
      .single();
    expect(a.error).toBeNull();
    expect((a.data as { terminal_id?: string } | null)?.terminal_id).toBe('POS-1');

    const b = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 100, terminal_id: 'POS-2' } as never)
      .select('id')
      .single();
    expect(b.error).toBeNull();

    const dup = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 0, terminal_id: 'POS-1' } as never)
      .select('id')
      .single();
    expect(dup.error?.code).toBe('23505');
  });

  itPlain('defaults terminal_id to POS-1 and rejects malformed ids', async () => {
    await closeAllOpen();
    const d = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 0 } as never)
      .select('terminal_id')
      .single();
    expect((d.data as { terminal_id?: string } | null)?.terminal_id).toBe('POS-1');

    const bad = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 0, terminal_id: 'no spaces' } as never)
      .select('id')
      .single();
    expect(bad.error?.code).toBe('23514');
  });

  itPlain('process_direct_sale_atomic rejects a caja from another terminal', async () => {
    await closeAllOpen();
    const s = await db
      .from('caja_sessions')
      .insert({ opened_by: MANAGER_ID, opening_cash: 0, terminal_id: 'POS-2' } as never)
      .select('id')
      .single();
    expect(s.error).toBeNull();

    const r = await db.rpc('process_direct_sale_atomic', {
      p_staff_id: MANAGER_ID,
      p_shift_id: '00000000-0000-0000-0000-000000000000',
      p_caja_session_id: (s.data as { id: string }).id,
      p_items: [],
      p_idempotency_key: `t-${String(Date.now())}`,
      p_terminal_id: 'POS-1',
    } as never);

    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ ok: false, code: 'CAJA_CLOSED' });
    expect((r.data as { message: string }).message).toContain('POS-2');
  });
});

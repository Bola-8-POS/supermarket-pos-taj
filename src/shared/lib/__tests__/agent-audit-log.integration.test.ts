// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { FIXTURE_ACCOUNTS, fixturePin, haveFixturePins } from '../../../test/fixture-accounts';

/**
 * Integration test: agent_audit_log's INSERT policy binds a row's user_id to
 * the session that wrote it (auth.uid()), not to whatever id the client
 * happens to send. Before this wave's migration, the policy's WITH CHECK
 * was `true`, so a signed-in session could write ANY user_id — this test's
 * second case is the RED proof for that gap (record accepted) and the GREEN
 * proof once the policy is bound.
 */
const TOOL_NAME = '__agent_audit_log_test__';

describe.skipIf(!haveFixturePins())('agent_audit_log insert policy (real Supabase)', () => {
  beforeAll(async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: FIXTURE_ACCOUNTS.cashier.email,
      password: fixturePin('cashier'),
    });
    if (error) throw new Error(`cashier sign-in: ${error.message}`);
  });

  afterEach(async () => {
    await testDb.from('agent_audit_log').delete().eq('tool_name', TOOL_NAME);
  });

  afterAll(async () => {
    await supabase.auth.signOut();
  });

  it("accepts an insert naming the signed-in session's own id", async () => {
    const { error } = await supabase.from('agent_audit_log').insert({
      tool_name: TOOL_NAME,
      user_id: FIXTURE_ACCOUNTS.cashier.id,
      user_role: 'cashier',
    });
    expect(error).toBeNull();
  });

  it("refuses an insert naming a different staff member's id", async () => {
    const { error } = await supabase.from('agent_audit_log').insert({
      tool_name: TOOL_NAME,
      user_id: FIXTURE_ACCOUNTS.manager.id,
      user_role: 'manager',
    });
    expect(error).not.toBeNull();
  });
});

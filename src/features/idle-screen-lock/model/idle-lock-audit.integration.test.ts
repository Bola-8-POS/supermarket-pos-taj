/**
 * Integration tests: screen.lock/screen.unlock audit accountability
 * (Phase 21, Plan 01 — LCK-04, D-05).
 *
 * Calls record_audit directly via a service-role client (same call shape
 * useIdleLockAudit.ts uses from the client) and asserts the resulting
 * audit_logs row's before/after JSON round-trips the exact staff identities
 * -- and that actor_id is NEVER the unlocking staff's id (RESEARCH.md
 * Pitfall 2 regression guard: the Supabase Auth session never changes across
 * a lock/unlock cycle, so actor_id cannot express "who unlocked").
 *
 * Requires: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd supermarket-pos && npx vitest run src/features/idle-screen-lock/model/idle-lock-audit.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey;

const TEST_TERMINAL_ID = '__test_idle_lock_audit__';

async function safe(p: PromiseLike<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // best-effort cleanup — ignore
  }
}

describe.skipIf(skip)('screen.lock/screen.unlock audit accountability (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!) as any;

  let sessionOwnerId: string;
  let sessionOwnerName: string;
  let unlockedById: string;
  let unlockedByName: string;

  async function createStaff(label: string): Promise<{ id: string; name: string }> {
    const email = `__idle_lock_audit_${label}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const name = `__idle_lock_audit_test_${label}__`;
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password: 'TestIdleLockAudit123!',
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`createStaff(${label}): ${createErr?.message}`);
    const id = authUser.user.id as string;

    const { error: profileErr } = await db.from('profiles').upsert({
      id,
      name,
      email,
      role: 'cashier',
      pin: label === 'owner' ? '999910' : '999911',
      is_active: true,
    });
    if (profileErr) throw new Error(`createStaff(${label}) profile upsert: ${profileErr.message}`);

    return { id, name };
  }

  beforeAll(async () => {
    const owner = await createStaff('owner');
    sessionOwnerId = owner.id;
    sessionOwnerName = owner.name;

    const unlocker = await createStaff('unlocker');
    unlockedById = unlocker.id;
    unlockedByName = unlocker.name;
  });

  afterAll(async () => {
    for (const id of [sessionOwnerId, unlockedById]) {
      if (!id) continue;
      await safe(db.from('profiles').delete().eq('id', id));
      await safe(db.auth.admin.deleteUser(id));
    }
    await safe(db.from('audit_logs').delete().eq('terminal_id', TEST_TERMINAL_ID));
  });

  it('screen.lock record_audit call produces an audit_logs row whose after column round-trips sessionOwnerStaffId/Name', async () => {
    const { data: logId, error } = await db.rpc('record_audit', {
      p_action: 'screen.lock',
      p_entity_type: 'shift',
      p_entity_id: null,
      p_before: null,
      p_after: { sessionOwnerStaffId: sessionOwnerId, sessionOwnerStaffName: sessionOwnerName },
      p_source: 'client',
      p_terminal_id: TEST_TERMINAL_ID,
      p_user_id: sessionOwnerId,
    });
    expect(error).toBeNull();
    expect(logId).toBeTruthy();

    const { data: row, error: fetchErr } = await db
      .from('audit_logs')
      .select('action, after, actor_id')
      .eq('id', logId)
      .single();
    expect(fetchErr).toBeNull();
    expect(row.action).toBe('screen.lock');
    expect(row.after.sessionOwnerStaffId).toBe(sessionOwnerId);
    expect(row.after.sessionOwnerStaffName).toBe(sessionOwnerName);
  });

  it('screen.unlock record_audit call names two DISTINCT staff identities in before/after, and actor_id is NEVER the unlocking staff (Pitfall 2)', async () => {
    const { data: logId, error } = await db.rpc('record_audit', {
      p_action: 'screen.unlock',
      p_entity_type: 'shift',
      p_entity_id: null,
      p_before: { sessionOwnerStaffId: sessionOwnerId, sessionOwnerStaffName: sessionOwnerName },
      p_after: { unlockedByStaffId: unlockedById, unlockedByStaffName: unlockedByName },
      p_source: 'client',
      p_terminal_id: TEST_TERMINAL_ID,
      // Mirrors production: p_user_id is the session owner's auth.uid(), NOT
      // the unlocking staff -- the Supabase Auth session never changes
      // across a lock/unlock cycle (Pitfall 1/2).
      p_user_id: sessionOwnerId,
    });
    expect(error).toBeNull();
    expect(logId).toBeTruthy();

    const { data: row, error: fetchErr } = await db
      .from('audit_logs')
      .select('action, before, after, actor_id')
      .eq('id', logId)
      .single();
    expect(fetchErr).toBeNull();
    expect(row.action).toBe('screen.unlock');
    expect(row.before.sessionOwnerStaffId).toBe(sessionOwnerId);
    expect(row.after.unlockedByStaffId).toBe(unlockedById);
    expect(row.before.sessionOwnerStaffId).not.toBe(row.after.unlockedByStaffId);
    expect(row.actor_id).toBe(sessionOwnerId);
    expect(row.actor_id).not.toBe(unlockedById);
  });
});

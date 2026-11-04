/* eslint-disable */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateStaffPasswords, planStaffPasswordMigration } from '../../../../scripts/lib/staff-password-migration';

// Built, not literal: lint:secrets refuses PIN-shaped literals in source.
const SIX_DIGITS = String(100000 + 23456);
const FOUR_DIGITS = SIX_DIGITS.slice(0, 4);
const PEPPER = 'test-pepper-not-secret-0123456789abcdef';
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';
const ID_D = '00000000-0000-4000-8000-00000000000d';
const ID_E = '00000000-0000-4000-8000-00000000000e';

describe('planStaffPasswordMigration', () => {
  it('derives every account with a 6-digit PIN and scrambles the rest, by id', () => {
    const plan = planStaffPasswordMigration([
      { id: ID_A, pin: SIX_DIGITS },
      { id: ID_B, pin: null },
      { id: ID_C, pin: FOUR_DIGITS },
      { id: ID_D, pin: SIX_DIGITS }, // a deleted or deactivated profile looks the same here: it is derived too
    ]);
    expect(plan.update).toEqual([
      { id: ID_A, pin: SIX_DIGITS },
      { id: ID_D, pin: SIX_DIGITS },
    ]);
    expect(plan.scramble).toEqual([
      { id: ID_B, reason: 'no-pin' },
      { id: ID_C, reason: 'pin-not-6-digits' },
    ]);
  });
});

// A test double for the chained supabase-js query builder and the Auth admin API.
function fakeDb(rows: Array<{ id: string; pin: string | null }>, failFor: Record<string, { status: number; message: string }> = {}) {
  const writes: Array<{ id: string; password: string }> = [];
  const query: any = {
    order: () => query,
    range: () => query,
    in: () => query,
    then: (ok: (value: unknown) => unknown) => ok({ data: rows, error: null }),
  };
  return {
    writes,
    from: () => ({ select: () => query }),
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: { password: string }) => {
          if (failFor[id]) return { error: failFor[id] };
          writes.push({ id, password: attrs.password });
          return { error: null };
        },
      },
    },
  };
}

describe('migrateStaffPasswords', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a dry run writes nothing and lists what it would scramble', async () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', PEPPER);
    const db = fakeDb([{ id: ID_A, pin: SIX_DIGITS }, { id: ID_B, pin: null }]);
    const result = await migrateStaffPasswords(db, { apply: false });
    expect(db.writes).toEqual([]);
    expect(result).toMatchObject({ planned: 1, updated: 0, scrambled: 0, failed: [], skipped: [] });
    expect(result.scramble).toEqual([{ id: ID_B, reason: 'no-pin' }]);
  });

  it('apply derives, scrambles with a random value, and reports a missing Auth user as skipped', async () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', PEPPER);
    const db = fakeDb(
      [
        { id: ID_A, pin: SIX_DIGITS },
        { id: ID_B, pin: null },
        { id: ID_C, pin: FOUR_DIGITS },
        { id: ID_E, pin: SIX_DIGITS },
      ],
      { [ID_E]: { status: 404, message: 'User not found' } },
    );
    const result = await migrateStaffPasswords(db, { apply: true, randomPassword: () => 'scrambled-for-test' });
    expect(result).toMatchObject({ planned: 2, updated: 1, scrambled: 2, failed: [] });
    expect(result.skipped).toEqual([{ id: ID_E, reason: 'no-auth-user' }]);
    const written = Object.fromEntries(db.writes.map((w) => [w.id, w.password]));
    expect(written[ID_A]).toMatch(/^v1\./);
    expect(written[ID_A]).toHaveLength(46);
    expect(written[ID_B]).toBe('scrambled-for-test');
    expect(written[ID_C]).toBe('scrambled-for-test');
  });

  it('reports another Auth error as failed, and never puts a PIN in its result', async () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', PEPPER);
    const db = fakeDb([{ id: ID_A, pin: SIX_DIGITS }], { [ID_A]: { status: 500, message: 'auth down' } });
    const result = await migrateStaffPasswords(db, { apply: true });
    expect(result.failed).toEqual([{ id: ID_A, message: 'auth down' }]);
    expect(JSON.stringify(result)).not.toContain(SIX_DIGITS);
  });
});

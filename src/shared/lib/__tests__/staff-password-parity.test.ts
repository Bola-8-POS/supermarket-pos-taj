/**
 * Pins the Node derivation (scripts/lib/staff-password.ts) to the same known-answer vectors as
 * the Deno one (supabase/functions/_shared/staff-password_test.ts). If the two ever disagree,
 * every staff account seeded by a script would fail to sign in through staff-sign-in.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveStaffPassword,
  resolveStaffPasswordPepper,
  StaffPasswordConfigError,
} from '../../../../scripts/lib/staff-password';

const PEPPER = 'test-pepper-not-secret-0123456789abcdef';
const ID = '00000000-0000-4000-8000-000000000001';

describe('deriveStaffPassword (Node twin)', () => {
  it('matches the shared known-answer vectors', async () => {
    expect(await deriveStaffPassword(ID, '123456', PEPPER)).toBe('v1.b-KxtbzaJ3Kj4qtelqO7EIC7CiCPzzZmWEW4T7b0afg');
    expect(await deriveStaffPassword(ID, '654321', PEPPER)).toBe('v1.06cJj2ek2d7hSpbiXnLIVW1MJaULMx0nH8qlDnyY1mM');
    expect(await deriveStaffPassword('00000000-0000-4000-8000-000000000002', '123456', PEPPER)).toBe(
      'v1.Ky3kYhaVTh0FuBRUP6kqZxqAzKdEWWPJ35k1wcI69Vc',
    );
    expect(await deriveStaffPassword('ABCDEF00-0000-4000-8000-0000000000AB', '123456', PEPPER)).toBe(
      'v1.Bt3Ec0OO3HlVZ1xK7K76_nzC7MsWf7e1zZt-2Fk_RP8',
    );
  });

  it('refuses a missing, short or low-entropy secret and malformed input', async () => {
    await expect(deriveStaffPassword(ID, '123456', null)).rejects.toBeInstanceOf(StaffPasswordConfigError);
    await expect(deriveStaffPassword(ID, '123456', 'short')).rejects.toBeInstanceOf(StaffPasswordConfigError);
    await expect(deriveStaffPassword(ID, '123456', '0'.repeat(64))).rejects.toBeInstanceOf(StaffPasswordConfigError);
    await expect(deriveStaffPassword(ID, '123456', 'ab'.repeat(32))).rejects.toBeInstanceOf(StaffPasswordConfigError);
    await expect(deriveStaffPassword('not-a-uuid', '123456', PEPPER)).rejects.toBeInstanceOf(TypeError);
    await expect(deriveStaffPassword(ID, '12345', PEPPER)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('resolveStaffPasswordPepper', () => {
  const dirs: string[] = [];
  // A temp project root whose supabase/functions/.env holds the given value.
  function rootWithFile(value: string): string {
    const root = mkdtempSync(join(tmpdir(), 'staff-pepper-'));
    dirs.push(root);
    mkdirSync(join(root, 'supabase', 'functions'), { recursive: true });
    writeFileSync(join(root, 'supabase', 'functions', '.env'), `STAFF_PASSWORD_PEPPER=${value}\n`);
    return root;
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('takes the environment variable first, whatever the target', () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', PEPPER);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.invalid');
    expect(resolveStaffPasswordPepper(rootWithFile(PEPPER + 'x'))).toBe(PEPPER);
  });

  it('reads the local functions .env only when the target is a loopback address', () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', '');
    const root = rootWithFile(PEPPER);
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56321');
    expect(resolveStaffPasswordPepper(root)).toBe(PEPPER);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.invalid');
    expect(resolveStaffPasswordPepper(root)).toBeNull();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_URL', '');
    expect(resolveStaffPasswordPepper(root)).toBeNull();
  });

  it('accepts 2,000 correctly generated 64-character hex peppers (the floor is 8 distinct characters)', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56321');
    for (let i = 0; i < 2000; i++) {
      const pepper = randomBytes(32).toString('hex');
      vi.stubEnv('STAFF_PASSWORD_PEPPER', pepper);
      expect(resolveStaffPasswordPepper()).toBe(pepper);
    }
  });

  it('refuses a short or low-entropy value from either source', () => {
    vi.stubEnv('STAFF_PASSWORD_PEPPER', 'ab'.repeat(32));
    expect(resolveStaffPasswordPepper()).toBeNull();
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56321');
    vi.stubEnv('STAFF_PASSWORD_PEPPER', '0'.repeat(64));
    expect(resolveStaffPasswordPepper(rootWithFile(PEPPER))).toBeNull();
    vi.stubEnv('STAFF_PASSWORD_PEPPER', '');
    expect(resolveStaffPasswordPepper(rootWithFile('0'.repeat(64)))).toBeNull();
    expect(resolveStaffPasswordPepper(rootWithFile('short'))).toBeNull();
  });
});

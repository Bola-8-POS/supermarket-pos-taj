/**
 * Cutover from "Auth password = raw PIN" to the derived staff password (two-mode plan 01).
 * Re-derives every staff member's Auth password from profiles.pin. Idempotent. Deleted and
 * deactivated profiles are derived too (a ban does not touch the password). A profile with no
 * usable PIN gets a random password instead of keeping a guessable one. Never logs a PIN, a
 * password or the secret.
 */
import { randomBytes } from 'node:crypto';
import { deriveStaffPassword } from './staff-password';

export interface StaffRow {
  id: string;
  pin: string | null;
}
export type ScrambleReason = 'no-pin' | 'pin-not-6-digits';
export type SkipReason = 'no-auth-user';
export interface MigrationPlan {
  update: Array<{ id: string; pin: string }>;
  scramble: Array<{ id: string; reason: ScrambleReason }>;
}
export interface MigrationResult {
  planned: number; // accounts that get the derived password
  updated: number;
  scramble: MigrationPlan['scramble']; // accounts with no usable PIN: they get a random password
  scrambled: number;
  failed: Array<{ id: string; message: string }>;
  skipped: Array<{ id: string; reason: SkipReason }>;
}

export function planStaffPasswordMigration(rows: StaffRow[]): MigrationPlan {
  const plan: MigrationPlan = { update: [], scramble: [] };
  for (const row of rows) {
    if (!row.pin) plan.scramble.push({ id: row.id, reason: 'no-pin' });
    else if (!/^\d{6}$/.test(row.pin)) plan.scramble.push({ id: row.id, reason: 'pin-not-6-digits' });
    else plan.update.push({ id: row.id, pin: row.pin });
  }
  return plan;
}

const isMissingUser = (e: { status?: number; code?: string }): boolean => e.status === 404 || e.code === 'user_not_found';

export async function migrateStaffPasswords(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role client from scripts, untyped like ensure-staff-account.ts
  db: any,
  opts: { apply: boolean; onlyIds?: string[]; randomPassword?: () => string },
): Promise<MigrationResult> {
  const rows: StaffRow[] = [];
  for (let from = 0; ; from += 1000) {
    let query = db.from('profiles').select('id, pin').order('id').range(from, from + 999);
    if (opts.onlyIds) query = query.in('id', opts.onlyIds);
    const { data, error } = await query;
    if (error) throw new Error(`profiles read failed: ${error.message}`);
    rows.push(...((data ?? []) as StaffRow[]));
    if (!data || data.length < 1000) break;
  }

  const plan = planStaffPasswordMigration(rows);
  const result: MigrationResult = {
    planned: plan.update.length,
    updated: 0,
    scramble: plan.scramble,
    scrambled: 0,
    failed: [],
    skipped: [],
  };
  if (!opts.apply) return result;

  const randomPassword = opts.randomPassword ?? ((): string => randomBytes(32).toString('base64url'));
  const record = (id: string, error: { status?: number; code?: string; message: string } | null, onOk: () => void): void => {
    if (!error) onOk();
    else if (isMissingUser(error)) result.skipped.push({ id, reason: 'no-auth-user' });
    else result.failed.push({ id, message: error.message });
  };

  for (const { id, pin } of plan.update) {
    const { error } = await db.auth.admin.updateUserById(id, { password: await deriveStaffPassword(id, pin) });
    record(id, error, () => (result.updated += 1));
  }
  for (const { id } of plan.scramble) {
    const { error } = await db.auth.admin.updateUserById(id, { password: randomPassword() });
    record(id, error, () => (result.scrambled += 1));
  }
  return result;
}

export type MigrationArgs = { ok: true; apply: boolean; onlyIds: string[] | undefined } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict CLI parsing: only `--apply` and `--only <id>[,<id>…]` exist. A malformed or unknown argument is
 * refused, never ignored, so a canary (`--only`) can never silently widen into a full cutover.
 */
export function parseMigrationArgs(argv: string[]): MigrationArgs {
  let apply = false;
  let onlyIds: string[] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--apply') apply = true;
    else if (arg === '--only') {
      if (onlyIds) return { ok: false, error: '--only given more than once' };
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: '--only needs a staff id (or a comma-separated list)' };
      i += 1;
      const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (ids.length === 0) return { ok: false, error: '--only needs at least one staff id' };
      if (ids.some((id) => !UUID_RE.test(id))) return { ok: false, error: '--only values must be staff UUIDs' };
      onlyIds = ids;
    } else if (arg.startsWith('--only')) return { ok: false, error: `unrecognised argument ${arg.split('=')[0]}: use "--only <id>", not "--only=<id>"` };
    else return { ok: false, error: `unrecognised argument ${arg.startsWith('--') ? arg : '(positional)'}; allowed: --apply, --only <id>[,<id>…]` };
  }
  return { ok: true, apply, onlyIds };
}

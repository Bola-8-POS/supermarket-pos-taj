/* eslint-disable */
import { describe, expect, it } from 'vitest';
import { parseMigrationArgs } from '../../../../scripts/lib/staff-password-migration';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000B';

describe('parseMigrationArgs', () => {
  it('no args is a dry run over every account', () => {
    expect(parseMigrationArgs([])).toEqual({ ok: true, apply: false, onlyIds: undefined });
  });
  it('--apply applies to every account', () => {
    expect(parseMigrationArgs(['--apply'])).toEqual({ ok: true, apply: true, onlyIds: undefined });
  });
  it('--only <uuid> scopes to that id', () => {
    expect(parseMigrationArgs(['--apply', '--only', ID_A])).toEqual({ ok: true, apply: true, onlyIds: [ID_A] });
  });
  it('--only takes a comma list and lower-cases ids', () => {
    expect(parseMigrationArgs(['--only', `${ID_A},${ID_B}`])).toEqual({
      ok: true,
      apply: false,
      onlyIds: [ID_A, ID_B.toLowerCase()],
    });
  });
  it.each([
    ['--only alone', ['--only']],
    ['--only with an empty value', ['--only', '']],
    ['--only with only commas', ['--only', ',']],
    ['--only=<uuid>', [`--only=${ID_A}`]],
    ['--only not a uuid', ['--only', 'notauuid']],
    ['one bad id in a list', ['--only', `${ID_A},notauuid`]],
    ['an unknown flag', ['--onyl', ID_A]],
    ['--bogus', ['--bogus']],
    ['a trailing --only after --apply', ['--apply', '--only']],
    ['--only followed by a flag', ['--only', '--apply']],
    ['a stray positional id', ['--only', ID_A, ID_B]],
    ['--only given twice', ['--only', ID_A, '--only', ID_B]],
  ])('refuses %s', (_name, argv) => {
    const r = parseMigrationArgs(argv as string[]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});

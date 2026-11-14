import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DEST, DEV_ESCROW_PUBKEY, fingerprint, validateRecipient } from './write-escrow-pubkey.mjs';

const REPO_PLACEHOLDER = 'PLACEHOLDER-NO-VENDOR-KEY';
const SCRIPT = fileURLToPath(new URL('./write-escrow-pubkey.mjs', import.meta.url));
// Well-formed recipients (bech32 body alphabet, 58 chars after "age1") that differ from the dev one.
const GOOD = `age1${'q'.repeat(29)}${'p'.repeat(29)}`;
const OTHER = `age1${'p'.repeat(29)}${'q'.repeat(29)}`;

function run(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'escrow-'));
  const dest = join(dir, 'posctl', 'escrow-pubkey.txt');
  const cleanEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env };
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--dest', dest], { env: cleanEnv, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, dest };
}

describe('validateRecipient', () => {
  it('accepts a well-formed recipient and strips one trailing newline', () => {
    expect(validateRecipient(GOOD)).toBe(GOOD);
    expect(validateRecipient(`${GOOD}\n`)).toBe(GOOD);
    expect(validateRecipient(`${GOOD}\r\n`)).toBe(GOOD);
    expect(validateRecipient(DEV_ESCROW_PUBKEY)).toBe(DEV_ESCROW_PUBKEY);
  });
  it.each([
    ['wrong prefix', `agf1${GOOD.slice(4)}`],
    ['too short', GOOD.slice(0, -1)],
    ['too long', `${GOOD}q`],
    ['uppercase', GOOD.toUpperCase()],
    ['a private key', `AGE-SECRET-KEY-1${'Q'.repeat(58)}`],
    ['inner whitespace', `${GOOD.slice(0, 20)} ${GOOD.slice(21)}`],
    ['two lines', `${GOOD}\n${GOOD}`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRecipient(value)).toThrow();
  });
});

describe('write-escrow-pubkey CLI', () => {
  it('the dev key is itself well-formed', () => {
    expect(DEV_ESCROW_PUBKEY).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
  });
  it('(a) release path fails clearly when no file and the variable is unset or empty', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'escrow-')), 'nope.txt');
    for (const env of [{}, { POS_ESCROW_PUBKEY: '' }]) {
      const r = run(['--override-file', missing, '--env', 'POS_ESCROW_PUBKEY'], env);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/POS_ESCROW_PUBKEY/);
    }
  });
  it('(b) rejects a malformed value from the variable', () => {
    const r = run(['--env', 'POS_ESCROW_PUBKEY'], { POS_ESCROW_PUBKEY: GOOD.toUpperCase() });
    expect(r.code).toBe(1);
  });
  it('(c) writes a well-formed key byte-exact with no trailing newline', () => {
    const r = run(['--env', 'POS_ESCROW_PUBKEY'], { POS_ESCROW_PUBKEY: `${GOOD}\n` });
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(GOOD);
  });
  it('(d) a customer file wins over the variable, and an invalid customer file does not fall back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'escrow-')), 'escrow-pubkey.txt');
    writeFileSync(file, OTHER);
    const r = run(['--override-file', file, '--env', 'POS_ESCROW_PUBKEY'], { POS_ESCROW_PUBKEY: GOOD });
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(OTHER);
    writeFileSync(file, 'not a key');
    const bad = run(['--override-file', file, '--env', 'POS_ESCROW_PUBKEY'], { POS_ESCROW_PUBKEY: GOOD });
    expect(bad.code).toBe(1);
  });
  it('(e) --dev writes the dev key, and the release path refuses that exact value', () => {
    const d = run(['--dev']);
    expect(d.code).toBe(0);
    expect(readFileSync(d.dest, 'utf8')).toBe(DEV_ESCROW_PUBKEY);
    const r = run(['--env', 'POS_ESCROW_PUBKEY'], { POS_ESCROW_PUBKEY: DEV_ESCROW_PUBKEY });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/development/i);
  });
});

describe('default output path', () => {
  it('(f) writes where posctl embeds it (store-server/resources), not under src-tauri', () => {
    expect(DEFAULT_DEST.split(sep).join('/').endsWith('/store-server/resources/escrow-pubkey.txt')).toBe(true);
    expect(DEFAULT_DEST).not.toContain('src-tauri');
  });
  it('(g) the committed file is exactly the placeholder: a --dev or customer key written into the work tree must not be committed unnoticed', () => {
    const committed = readFileSync(DEFAULT_DEST, 'utf8');
    expect(committed.replace(/\r?\n$/, '')).toBe(REPO_PLACEHOLDER);
    expect(committed).not.toContain(DEV_ESCROW_PUBKEY);
  });
});

describe('pinned fingerprint', () => {
  const PH = 'PLACEHOLDER-NO-VENDOR-KEY-FINGERPRINT';
  const pinFile = (content) => {
    const f = join(mkdtempSync(join(tmpdir(), 'escrow-fp-')), 'escrow-pubkey.fingerprint');
    writeFileSync(f, content);
    return f;
  };
  it('fingerprint is the lowercase hex sha256 of the trimmed recipient', () => {
    expect(fingerprint(`${GOOD}\n`)).toBe(fingerprint(GOOD));
    expect(fingerprint(GOOD)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a variable key passes when it matches the pin; a changed key, the placeholder and a missing file all fail', () => {
    const fp = pinFile(`${fingerprint(GOOD)}\n`);
    expect(run(['--env', 'POS_ESCROW_PUBKEY', '--fingerprint-file', fp], { POS_ESCROW_PUBKEY: GOOD }).code).toBe(0);
    const changed = run(['--env', 'POS_ESCROW_PUBKEY', '--fingerprint-file', fp], { POS_ESCROW_PUBKEY: OTHER });
    expect(changed.code).toBe(1);
    expect(changed.out).toMatch(/does not match/);
    const ph = run(['--env', 'POS_ESCROW_PUBKEY', '--fingerprint-file', pinFile(PH)], { POS_ESCROW_PUBKEY: GOOD });
    expect(ph.code).toBe(1);
    expect(ph.out).toMatch(/placeholder/i);
    expect(run(['--env', 'POS_ESCROW_PUBKEY', '--fingerprint-file', join(dirname(fp), 'nope')], { POS_ESCROW_PUBKEY: GOOD }).code).toBe(1);
  });
  it('a customer key is checked against its own folder fingerprint, not the global one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'escrow-cust-'));
    const keyFile = join(dir, 'escrow-pubkey.txt');
    writeFileSync(keyFile, OTHER);
    const global = pinFile(fingerprint(OTHER));
    expect(run(['--override-file', keyFile, '--fingerprint-file', global]).code).toBe(1); // no customer fingerprint file
    writeFileSync(join(dir, 'escrow-pubkey.fingerprint'), fingerprint(GOOD));
    expect(run(['--override-file', keyFile, '--fingerprint-file', global]).code).toBe(1); // wrong customer pin
    writeFileSync(join(dir, 'escrow-pubkey.fingerprint'), fingerprint(OTHER));
    expect(run(['--override-file', keyFile, '--fingerprint-file', pinFile(PH)]).code).toBe(0);
  });
  it('the committed fingerprint file is the placeholder until the ceremony', () => {
    expect(readFileSync(join(dirname(DEFAULT_DEST), 'escrow-pubkey.fingerprint'), 'utf8').trim()).toBe(PH);
  });
});

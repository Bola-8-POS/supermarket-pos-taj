// Writes store-server/resources/escrow-pubkey.txt, the vendor backup-key escrow PUBLIC key (an age X25519 recipient) that posctl embeds
// at compile time (store-server/src/backup/escrow.rs, include_str!). The committed file holds PLACEHOLDER-NO-VENDOR-KEY; a release run
// overwrites it BEFORE `cargo build` of store-server, and release.yml then refuses a build that still carries the placeholder.
//   node scripts/write-escrow-pubkey.mjs --override-file customers/<name>/escrow-pubkey.txt --env POS_ESCROW_PUBKEY
//   node scripts/write-escrow-pubkey.mjs --dev      (a throwaway recipient for CI and local builds; a release refuses it)
// A customer file wins over the variable; an invalid customer file fails instead of falling back.
// Pinned fingerprint (--fingerprint-file store-server/resources/escrow-pubkey.fingerprint): the resolved key must hash to the committed value, so
// changing the Actions variable alone cannot redirect recovery keys. Fingerprint = lowercase hex SHA-256 of the exact trimmed age1 recipient string
// (UTF-8, no newline). The committed file holds PLACEHOLDER-NO-VENDOR-KEY-FINGERPRINT until the vendor ceremony; that never matches, so a release fails.
// Rule: a key taken from customers/<name>/escrow-pubkey.txt must match customers/<name>/escrow-pubkey.fingerprint (same folder, reviewed with it);
// a key taken from the variable must match the committed global file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DEST = join(ROOT, 'store-server', 'resources', 'escrow-pubkey.txt');
// The public recipient from the age specification examples: well-formed, private key unknown to us, never usable for a release.
export const DEV_ESCROW_PUBKEY = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;

export function validateRecipient(text) {
  const value = String(text).replace(/\r?\n$/, '');
  if (!RECIPIENT_RE.test(value)) throw new Error('escrow public key must be one age recipient line: age1 followed by 58 lowercase bech32 characters');
  return value;
}

/** Release resolution: customer file, else the variable. Throws when neither yields a valid, non-dev key. */
export function fingerprint(recipient) {
  return createHash('sha256').update(recipient.trim(), 'utf8').digest('hex');
}

/** Throws unless `recipient` hashes to the (trimmed) content of `file`; a missing file, the placeholder or any non-hex value fails too. */
export function checkFingerprint(recipient, file) {
  if (!existsSync(file)) throw new Error(`pinned escrow fingerprint file ${file} is missing`);
  const expected = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${file} does not hold a SHA-256 fingerprint (placeholder before the vendor ceremony?); a release cannot ship until the ceremony commit`);
  const got = fingerprint(recipient);
  if (got !== expected) throw new Error(`escrow public key fingerprint ${got} does not match ${file} (${expected}); the key was changed without a reviewed commit`);
}

export function resolveRecipient({ overrideFile, envName, env = process.env, fingerprintFile }) {
  let raw;
  let source;
  if (overrideFile && existsSync(overrideFile)) {
    raw = readFileSync(overrideFile, 'utf8');
    source = overrideFile;
  } else if (envName && env[envName]) {
    raw = env[envName];
    source = `variable ${envName}`;
  } else {
    throw new Error(`no escrow public key: ${overrideFile ?? '(no file)'} is absent and ${envName ?? 'the environment variable'} is unset or empty`);
  }
  let value;
  try {
    value = validateRecipient(raw);
  } catch (err) {
    throw new Error(`${source}: ${err.message}`);
  }
  if (value === DEV_ESCROW_PUBKEY) throw new Error(`${source}: this is the development escrow key, which must never ship in a release`);
  if (fingerprintFile) {
    const pin = source === overrideFile ? join(dirname(overrideFile), 'escrow-pubkey.fingerprint') : fingerprintFile;
    try {
      checkFingerprint(value, pin);
    } catch (err) {
      throw new Error(`${source}: ${err.message}`);
    }
  }
  return value;
}

export function writeRecipient(value, dest = DEFAULT_DEST) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, value);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { values } = parseArgs({ options: { 'override-file': { type: 'string' }, env: { type: 'string' }, dev: { type: 'boolean', default: false }, 'fingerprint-file': { type: 'string' }, dest: { type: 'string' } } });
  try {
    const value = values.dev ? DEV_ESCROW_PUBKEY : resolveRecipient({ overrideFile: values['override-file'], envName: values.env, fingerprintFile: values['fingerprint-file'] });
    writeRecipient(value, values.dest ?? DEFAULT_DEST);
    console.log(`wrote ${values.dest ?? DEFAULT_DEST}`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
}

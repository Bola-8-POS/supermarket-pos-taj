import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for edge-function import specifiers: for every function
 * directory (read from disk, so a new function is covered automatically),
 * an unauthenticated POST against the local edge runtime must not 404, and
 * a 5xx is only acceptable when it is the function's OWN error envelope
 * (from _shared/errors.ts), not the runtime failing to load the module.
 * A 401/400/405 (or a 5xx carrying a code from the function's own allow
 * list, isFunctionErrorCode below) means the module loaded and ran; a 404
 * means the runtime does not serve that function at all; a 5xx whose body
 * has no string `code`, or whose code is not one a function's own fail()
 * call can emit, means the module failed to resolve or boot.
 *
 * The apikey header is mandatory: without it, the gateway refuses every
 * verify_jwt = true function before the module ever runs, which would make
 * a 401 ambiguous between "Kong refused it" and "the function itself ran".
 * get-server-time (verify_jwt = false) answers 200 either way, so it also
 * gets a direct GET check.
 *
 * Run this once against the pre-repin specifiers and once after (see the
 * task report for both counts) — the value here is catching a future
 * specifier change that breaks a function's boot, not a one-off proof.
 */
// Pulls the error code out of whichever envelope shape _shared/errors.ts
// used for this response: 'nested'/'ok' put it at body.error.code, 'flat'
// puts the code string itself at body.error. Falls back to a top-level
// body.code in case the runtime's own boot-failure body is flat.
function extractErrorCode(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    if (typeof record.error === 'string') return record.error;
    if (record.error && typeof record.error === 'object') {
      return (record.error as Record<string, unknown>).code;
    }
  }
  return undefined;
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FUNCTIONS_DIR = join(ROOT, 'supabase', 'functions');

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

const functionNames = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
  .map((entry) => entry.name)
  .sort();

// Allow-list, not the RUNTIME_BOOT_CODES deny-list: _shared/errors.ts's
// DEFAULT_MESSAGES (25 codes) plus every literal `fail(req, 5xx, '<code>')`
// code found outside it by `grep -rnE "fail\(req,\s*5[0-9]{2}," supabase/functions`
// (2: SIGN_IN_STATE_FAILED, STAFF_RECORD_FAILED, both in
// set-staff-active/index.ts). Together, every code a function's own 5xx
// envelope can legitimately carry — a code outside this set means the
// runtime's own boot-failure body reached the assertion, not the
// function's.
const ALLOWED_ERROR_CODES = new Set([
  // _shared/errors.ts DEFAULT_MESSAGES
  'METHOD_NOT_ALLOWED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'CONFIG',
  'INVALID_JSON',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
  'SUPABASE_ERROR',
  'RPC_ERROR',
  'DB_ERROR',
  'PAYMENT_FAILED',
  'PAYMENT_FETCH',
  'TAB_FETCH',
  'ORDERS_FETCH',
  'RECEIPT_FETCH',
  'DIRECT_SALE_FAILED',
  'RECEIVE_SHIPMENT_FAILED',
  'RESTORE_FAILED',
  'RESEND_ERROR',
  'AUTH_WRITE_FAILED',
  'PROFILE_WRITE_FAILED',
  'MODEL_NOT_ALLOWED',
  'ANTHROPIC_ERROR',
  // literal fail(req, 5xx, '<code>') codes outside DEFAULT_MESSAGES
  'SIGN_IN_STATE_FAILED',
  'STAFF_RECORD_FAILED',
]);

export function isFunctionErrorCode(code: unknown): boolean {
  return typeof code === 'string' && ALLOWED_ERROR_CODES.has(code);
}

describe('isFunctionErrorCode', () => {
  it('accepts a code from _shared/errors.ts DEFAULT_MESSAGES', () => {
    expect(isFunctionErrorCode('VALIDATION_ERROR')).toBe(true);
  });

  it('accepts a literal fail() code outside DEFAULT_MESSAGES (set-staff-active)', () => {
    expect(isFunctionErrorCode('STAFF_RECORD_FAILED')).toBe(true);
  });

  it('rejects an unknown code', () => {
    expect(isFunctionErrorCode('NOT_A_REAL_CODE')).toBe(false);
  });
});

describe.skipIf(!url || !anonKey)('edge functions boot', () => {
  it.each(functionNames)('%s: unauthenticated POST is not a 404 or a runtime boot failure', async (name) => {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: anonKey as string, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(404);
    if (res.status >= 500) {
      const body: unknown = await res.json();
      const code = extractErrorCode(body);
      expect(isFunctionErrorCode(code)).toBe(true);
    }
  });

  it('get-server-time: unauthenticated GET is 200', async () => {
    const res = await fetch(`${url}/functions/v1/get-server-time`, {
      method: 'GET',
      headers: { apikey: anonKey as string },
    });
    expect(res.status).toBe(200);
  });
});

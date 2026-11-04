import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The four functions that set or check a staff member's Auth password derive it from
// STAFF_PASSWORD_PEPPER, read the secret before they touch a credential or spend a PIN attempt,
// and never try the raw PIN.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Comment lines are stripped so a comment that names the secret cannot satisfy an ordering check.
const source = (name) =>
  readFileSync(join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');

const FUNCTIONS = ['staff-sign-in', 'create-staff', 'admin-reset-pin', 'change-own-pin'];
// The first call that spends a PIN attempt or writes a credential in each function.
const FIRST_CREDENTIAL_USE = {
  'staff-sign-in': "'pin_attempt_begin'",
  'create-staff': 'createUser(',
  'admin-reset-pin': 'writeCredential(',
  'change-own-pin': 'writeCredential(',
};

describe('staff credential functions: derived password, fail closed', () => {
  it.each(FUNCTIONS)('%s never uses the raw PIN as an Auth password', (name) => {
    expect(source(name)).not.toMatch(/password:\s*(?:new)?[Pp]in\b/);
  });

  it.each(Object.entries(FIRST_CREDENTIAL_USE))('%s reads the secret, then refuses, before %s', (name, boundaryText) => {
    const text = source(name);
    const pepper = text.indexOf('staffPasswordPepper()');
    expect(pepper).toBeGreaterThanOrEqual(0);
    const refusal = text.search(/if\s*\(\s*!pepper\s*\)/);
    const boundary = text.indexOf(boundaryText);
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(pepper);
    expect(refusal).toBeLessThan(boundary);
  });
});

describe('staff-sign-in gives a PIN attempt back when it fails without evaluating the PIN', () => {
  const text = source('staff-sign-in');
  // The five 503 branches, in source order: [0] secret missing (answered before any attempt is
  // counted), [1] the first pin_attempt_begin failed (rolled back, nothing counted), [2] the second
  // begin failed, [3] the profile lookup failed, [4] Auth answered with a non-credential error.
  const unavailable = [...text.matchAll(/return json\(req, \{ error: 'UNAVAILABLE' \}, 503\)/g)].map((m) => m.index);

  it('still has the five 503 branches this guard knows about', () => {
    expect(unavailable).toHaveLength(5);
  });

  it('does not refund where nothing was counted', () => {
    expect(text.slice(0, unavailable[1])).not.toContain('refundPinAttempts(');
  });

  it.each([2, 3, 4])('refunds before the 503 at branch %i', (k) => {
    expect(text.slice(unavailable[k - 1] + 1, unavailable[k])).toContain('refundPinAttempts(');
  });

  it('classifies the Auth error with isAuthServiceFault before the Auth 503, not by status alone', () => {
    const beforeAuth503 = text.slice(unavailable[3] + 1, unavailable[4]);
    expect(beforeAuth503).toContain('isAuthServiceFault(error)');
    expect(beforeAuth503).not.toMatch(/error\.status\s*!==\s*400/);
  });

  it('the classifier refunds only HOOK_REJECTED among hook verdicts, and excludes HOOK_ERROR before the status test', () => {
    const helper = readFileSync(join(ROOT, 'supabase', 'functions', '_shared', 'pin-attempt-refund.ts'), 'utf8');
    // The helper's doc comment names HOOK_ERROR on purpose; only executable code must not mention it.
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain("error.message === 'HOOK_REJECTED'");
    expect(code).toContain("error.message === 'HOOK_ERROR'");
    expect(code.indexOf("error.message === 'HOOK_ERROR'")).toBeLessThan(code.indexOf('error.status !== 400'));
  });
});

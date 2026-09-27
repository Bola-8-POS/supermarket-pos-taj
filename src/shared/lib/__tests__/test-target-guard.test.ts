/**
 * Unit tests for the shared local-only test-target guard. See
 * src/shared/lib/test-target-guard.ts for the contract.
 */
import { describe, expect, it } from 'vitest';
import { assertLocalTestTarget, REMOTE_TARGET_ENV, TestTargetError } from '../test-target-guard';

const REMOTE = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';

describe('assertLocalTestTarget', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321/',
    'https://localhost',
    'http://[::1]:54321',
  ])('allows loopback target %s', url => {
    expect(() => assertLocalTestTarget(url, {})).not.toThrow();
  });

  it('refuses a synthetic remote host with no allow variable', () => {
    expect(() => assertLocalTestTarget(REMOTE, {})).toThrow(TestTargetError);
  });

  it('refuses a userinfo trick where the parsed host is remote', () => {
    const tricky = `https://127.0.0.1@aaaaaaaaaaaaaaaaaaaa.supabase.co`;
    expect(() => assertLocalTestTarget(tricky, {})).toThrow(TestTargetError);
  });

  it('allows a remote host when the allow variable names the exact origin', () => {
    const env = { [REMOTE_TARGET_ENV]: REMOTE };
    expect(() => assertLocalTestTarget(REMOTE, env)).not.toThrow();
  });

  it('normalises a trailing slash and the default port on the allow variable', () => {
    const withSlash = { [REMOTE_TARGET_ENV]: 'https://x.supabase.co/' };
    const withPort = { [REMOTE_TARGET_ENV]: 'https://x.supabase.co:443' };
    expect(() => assertLocalTestTarget('https://x.supabase.co', withSlash)).not.toThrow();
    expect(() => assertLocalTestTarget('https://x.supabase.co', withPort)).not.toThrow();
  });

  it('refuses a different origin than the allow variable', () => {
    const env = { [REMOTE_TARGET_ENV]: 'https://other-host.supabase.co' };
    expect(() => assertLocalTestTarget(REMOTE, env)).toThrow(TestTargetError);
  });

  it('refuses a different scheme than the allow variable', () => {
    const env = { [REMOTE_TARGET_ENV]: 'http://aaaaaaaaaaaaaaaaaaaa.supabase.co' };
    expect(() => assertLocalTestTarget(REMOTE, env)).toThrow(TestTargetError);
  });

  it('throws TestTargetError, not TypeError, on a malformed allow value', () => {
    const env = { [REMOTE_TARGET_ENV]: 'not a url' };
    expect(() => assertLocalTestTarget(REMOTE, env)).toThrow(TestTargetError);
  });

  it('throws on empty input', () => {
    expect(() => assertLocalTestTarget('', {})).toThrow(TestTargetError);
    expect(() => assertLocalTestTarget(undefined, {})).toThrow(TestTargetError);
  });

  it('throws on garbage input', () => {
    expect(() => assertLocalTestTarget('not a url', {})).toThrow(TestTargetError);
  });

  it('returns the parsed URL on success', () => {
    const result = assertLocalTestTarget('http://127.0.0.1:54321', {});
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe('127.0.0.1');
  });

  it('refuses a synthetic remote host with an explicit empty env even when the allow variable is set in process.env', () => {
    const prev = process.env[REMOTE_TARGET_ENV];
    process.env[REMOTE_TARGET_ENV] = REMOTE;
    try {
      expect(() => assertLocalTestTarget(REMOTE, {})).toThrow(TestTargetError);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, REMOTE_TARGET_ENV);
      else process.env[REMOTE_TARGET_ENV] = prev;
    }
  });

  it('refusal message names the hostname and the variable, never a path or query', () => {
    const url = `${REMOTE}/some/secret/path?token=abc123#frag`;
    let message = '';
    try {
      assertLocalTestTarget(url, {});
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('aaaaaaaaaaaaaaaaaaaa.supabase.co');
    expect(message).toContain(REMOTE_TARGET_ENV);
    expect(message).not.toContain('secret');
    expect(message).not.toContain('token');
    expect(message).not.toContain('?');
    expect(message).not.toContain('#');
  });
});

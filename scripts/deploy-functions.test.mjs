import { describe, expect, it } from 'vitest';

import { checkRef, listFunctions, parseArgs } from './deploy-functions.mjs';

const OURS = 'xmjpnhowadqgewuxpqva';
const CUSTOMER = 'mkvinyekkyennyegfoxq';
const SCRATCH = 'abcdefghijklmnopqrst';

describe('checkRef', () => {
  it('refuses protected refs without the flag', () => {
    expect(checkRef(OURS, false)).toMatch(/refusing/);
    expect(checkRef(CUSTOMER, false)).toMatch(/refusing/);
  });
  it('allows protected refs with the flag and other refs without it', () => {
    expect(checkRef(OURS, true)).toBeNull();
    expect(checkRef(SCRATCH, false)).toBeNull();
  });
  it('rejects missing or malformed refs', () => {
    expect(checkRef('', true)).toMatch(/invalid/);
    expect(checkRef('nope', true)).toMatch(/invalid/);
  });
});

describe('parseArgs / listFunctions', () => {
  it('parses flags and rejects unknown ones', () => {
    expect(parseArgs(['--project-ref', SCRATCH, '--dry-run', '--functions', 'a,b'])).toMatchObject({
      ref: SCRATCH, dryRun: true, functions: ['a', 'b'],
    });
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
  it('lists real functions without _shared', () => {
    const fns = listFunctions(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    expect(fns).toContain('process-payment');
    expect(fns).not.toContain('_shared');
  });
});

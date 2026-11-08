import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isScanned, scanBuffer, scanFiles } from './check-control-bytes.mjs';

describe('scanBuffer', () => {
  it('reports the line of a backspace, a NUL and a form feed, and allows tab, LF and CR', () => {
    const buf = Buffer.from([...Buffer.from('ok\ttab\r\nline2 '), 0x08, ...Buffer.from('x\nline3 '), 0x00, 0x0c]);
    expect(scanBuffer(buf)).toEqual([
      { line: 2, byte: 0x08 },
      { line: 3, byte: 0x00 },
      { line: 3, byte: 0x0c },
    ]);
  });
  it('accepts clean text including UTF-8 and escaped backslash sequences', () => {
    expect(scanBuffer(Buffer.from('state\\backup.json \u2014 \'\\0\'\n'))).toEqual([]);
  });
});

describe('isScanned', () => {
  it('scans source text and skips binaries, snapshots and fixtures', () => {
    expect(isScanned('store-server/src/tasks.rs')).toBe(true);
    expect(isScanned('docs/plan.md')).toBe(true);
    expect(isScanned('logo.png')).toBe(false);
    expect(isScanned('e2e/visual/a.spec.ts-snapshots/x.json')).toBe(false);
    expect(isScanned('src/__snapshots__/a.json')).toBe(false);
    expect(isScanned('e2e/fixtures/bad.json')).toBe(false);
  });
});

describe('scanFiles', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctrl-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names file:line for a hit and nothing for a clean file', () => {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'bad.rs'), Buffer.from([0x61, 0x0a, 0x08]));
    writeFileSync(join(dir, 'a', 'good.rs'), 'fine\n');
    expect(scanFiles(dir, ['a/bad.rs', 'a/good.rs', 'a/gone.rs'])).toEqual(['a/bad.rs:2: control byte 0x08']);
  });
});

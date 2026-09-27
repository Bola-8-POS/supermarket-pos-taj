import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectEntrypoints, main } from './deno-functions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('collectEntrypoints', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deno-functions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds every .ts file recursively, sorted, excluding deno.lock/deno.json', () => {
    mkdirSync(join(dir, 'fn-b'));
    mkdirSync(join(dir, '_shared'));
    writeFileSync(join(dir, 'fn-b', 'index.ts'), '');
    writeFileSync(join(dir, '_shared', 'caller.ts'), '');
    writeFileSync(join(dir, 'deno.lock'), '{}');
    writeFileSync(join(dir, 'deno.json'), '{}');

    const files = collectEntrypoints(dir);

    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('deno.lock') || f.endsWith('deno.json'))).toBe(false);
    expect(files).toEqual([...files].sort());
  });

});

describe('collectEntrypoints: real tree', () => {
  it('finds every checked-in entrypoint and _shared helper under supabase/functions', () => {
    const files = collectEntrypoints(join(ROOT, 'supabase', 'functions'));
    expect(files.some((f) => f.endsWith('agent-proxy/index.ts') || f.endsWith('agent-proxy\\index.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('_shared/caller.ts') || f.endsWith('_shared\\caller.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });
});

describe('main()', () => {
  it('runs deno check with the collected entrypoints and the shared config', async () => {
    const run = vi.fn(() => ({ status: 0 }));
    const code = await main(['check'], { run });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args] = run.mock.calls[0];
    expect(cmd).toBe('deno');
    expect(args[0]).toBe('check');
    expect(args).toContain('--config');
    expect(args.some((a) => a.endsWith('deno.json'))).toBe(true);
    expect(args.length).toBeGreaterThan(3);
  });

  it('runs deno install with --entrypoint and no --frozen by default', async () => {
    const run = vi.fn(() => ({ status: 0 }));
    const code = await main(['lock'], { run });
    expect(code).toBe(0);
    const args = run.mock.calls[0][1];
    expect(args[0]).toBe('install');
    expect(args).toContain('--entrypoint');
    expect(args).not.toContain('--frozen');
  });

  it('runs deno install with --frozen, before --entrypoint, when passed', async () => {
    const run = vi.fn(() => ({ status: 0 }));
    await main(['lock', '--frozen'], { run });
    const args = run.mock.calls[0][1];
    expect(args).toContain('--frozen');
    expect(args.indexOf('--frozen')).toBeLessThan(args.indexOf('--entrypoint'));
  });

  it('propagates a non-zero exit code from the spawned deno process', async () => {
    const run = vi.fn(() => ({ status: 1 }));
    const code = await main(['check'], { run });
    expect(code).toBe(1);
  });

  it('returns 1 and prints an error for an unknown command', async () => {
    const error = vi.fn();
    const code = await main(['bogus'], { error });
    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});

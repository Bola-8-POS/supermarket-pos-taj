import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkImports, main, walkTsFiles } from './check-function-imports.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('checkImports: exact-version rule', () => {
  it('flags a floating major', () => {
    const files = new Map([['a/index.ts', "import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 1,
      rule: 'exact-version',
      specifier: 'https://esm.sh/@supabase/supabase-js@2',
    });
  });

  it('does not flag a scoped package with an exact patch version (the leading-@ false positive)', () => {
    const files = new Map([
      ['a/index.ts', "import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'exact-version')).toEqual([]);
  });

  it('passes a deno.land/std exact version', () => {
    const files = new Map([['a/index.ts', "import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'\n"]]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'exact-version')).toEqual([]);
  });

  it('passes a deno.land/x exact version', () => {
    const files = new Map([['a/index.ts', "import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n"]]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'exact-version')).toEqual([]);
  });
});

describe('checkImports: allowed-host rule', () => {
  it('flags an unlisted host', () => {
    const files = new Map([['a/index.ts', "import { z } from 'https://unpkg.com/zod@3.23.8'\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 1,
      rule: 'allowed-host',
      specifier: 'https://unpkg.com/zod@3.23.8',
    });
  });

  it('allows esm.sh, deno.land, npm: and jsr: hosts', () => {
    const files = new Map([
      ['a.ts', "import { a } from 'https://esm.sh/zod@3.23.8'\n"],
      ['b.ts', "import { b } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n"],
      ['c.ts', "import { c } from 'npm:zod@3.23.8'\n"],
      ['d.ts', "import { d } from 'jsr:@std/path@1.0.8'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'allowed-host')).toEqual([]);
  });
});

describe('checkImports: one-version rule', () => {
  it('flags the same package at two versions', () => {
    const files = new Map([
      ['a.ts', "import { a } from 'https://esm.sh/@supabase/supabase-js@2'\n"],
      ['b.ts', "import { b } from 'https://esm.sh/@supabase/supabase-js@2.49.1'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'one-version')).toHaveLength(2);
  });

  it('flags the same package/version served from two hosts', () => {
    const files = new Map([
      ['a.ts', "import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n"],
      ['b.ts', "import { z } from 'https://esm.sh/zod@3.23.8'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'one-version')).toHaveLength(2);
  });

  it('treats every deno.land/std version as the same package', () => {
    const files = new Map([
      ['a.ts', "import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'\n"],
      ['b.ts', "import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'one-version')).toHaveLength(2);
  });

  it('does not flag a single version at a single host', () => {
    const files = new Map([
      ['a.ts', "import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n"],
      ['b.ts', "import { z2 } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations.filter((v) => v.rule === 'one-version')).toEqual([]);
  });
});

describe('checkImports: relative imports and dynamic import', () => {
  it('ignores a relative import', () => {
    const files = new Map([['a.ts', "import { x } from '../_shared/cors.ts'\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toEqual([]);
  });

  it('checks a dynamic import() of a string literal', () => {
    const files = new Map([['a.ts', "const mod = await import('https://esm.sh/@supabase/supabase-js@2')\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a.ts',
      line: 1,
      rule: 'exact-version',
      specifier: 'https://esm.sh/@supabase/supabase-js@2',
    });
  });
});

describe('checkImports: multi-line and side-effect imports', () => {
  it('flags a multi-line import with a floating major', () => {
    const files = new Map([
      ['a/index.ts', "import {\n  createClient,\n} from 'https://esm.sh/@supabase/supabase-js@2'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 1,
      rule: 'exact-version',
      specifier: 'https://esm.sh/@supabase/supabase-js@2',
    });
  });

  it('flags a side-effect import with a floating major', () => {
    const files = new Map([['a/index.ts', "import 'https://esm.sh/pkg@1'\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 1,
      rule: 'exact-version',
      specifier: 'https://esm.sh/pkg@1',
    });
  });

  it('does not flag a multi-line import with an exact version', () => {
    const files = new Map([
      ['a/index.ts', "import {\n  createClient,\n} from 'https://esm.sh/@supabase/supabase-js@2.49.1'\n"],
    ]);
    const { violations } = checkImports(files);
    expect(violations).toEqual([]);
  });

  it('does not flag a node: built-in as an unlisted host', () => {
    const files = new Map([['a/index.ts', "import { randomUUID } from 'node:crypto'\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toEqual([]);
  });
});

describe('checkImports: violation line number', () => {
  it('reports the import keyword line, not the previous statement\'s semicolon line', () => {
    const files = new Map([['a/index.ts', "import a from './a.ts';\nimport b from 'https://esm.sh/b@1';\n"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 2,
      rule: 'exact-version',
      specifier: 'https://esm.sh/b@1',
    });
  });

  it('reports the import keyword line, not the blank line before it', () => {
    const files = new Map([['a/index.ts', "import a from './a.ts'\n\nimport b from 'https://esm.sh/b@2'"]]);
    const { violations } = checkImports(files);
    expect(violations).toContainEqual({
      file: 'a/index.ts',
      line: 3,
      rule: 'exact-version',
      specifier: 'https://esm.sh/b@2',
    });
  });
});

describe('checkImports: real tree', () => {
  it('has no violations on the checked-in supabase/functions tree', () => {
    const functionsDir = join(ROOT, 'supabase', 'functions');
    const files = walkTsFiles(functionsDir);
    const { violations } = checkImports(files);
    expect(violations).toEqual([]);
  });
});

describe('main()', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-function-imports-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 and prints a violation line for a floating import', async () => {
    mkdirSync(join(dir, 'fn'));
    writeFileSync(join(dir, 'fn', 'index.ts'), "import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'\n");
    const log = vi.fn();
    const error = vi.fn();
    const code = await main(['--dir', dir], { log, error });
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toMatch(/exact-version/);
  });

  it('prints ok and exits 0 on a clean tree', async () => {
    mkdirSync(join(dir, 'fn'));
    writeFileSync(join(dir, 'fn', 'index.ts'), "import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'\n");
    const log = vi.fn();
    const error = vi.fn();
    const code = await main(['--dir', dir], { log, error });
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join(' ')).toMatch(/check-function-imports: ok/);
  });
});

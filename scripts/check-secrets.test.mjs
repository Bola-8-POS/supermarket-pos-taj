import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAllowed, main, parseAllowList, scanTree } from './check-secrets.mjs';

const REAL_ALLOW_LIST_TEXT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'lib', 'secret-scan-allow.txt'),
  'utf8',
);

describe('parseAllowList', () => {
  it('parses prefix, suffix, rule-scoped and wildcard entries, and ignores comments/blank lines', () => {
    const text = [
      '# a full-line comment',
      '',
      'e2e/ * # end-to-end fixtures',
      'suffix:.test.ts * # unit test fixtures',
      'supabase/seed.sql repeated-digits # dev seed',
      'HANDOFF.md * # never exported',
    ].join('\n');

    expect(parseAllowList(text)).toEqual([
      { entry: 'e2e/', rule: '*', reason: 'end-to-end fixtures' },
      { entry: 'suffix:.test.ts', rule: '*', reason: 'unit test fixtures' },
      { entry: 'supabase/seed.sql', rule: 'repeated-digits', reason: 'dev seed' },
      { entry: 'HANDOFF.md', rule: '*', reason: 'never exported' },
    ]);
  });
});

describe('isAllowed', () => {
  const allowList = parseAllowList(
    ['e2e/ * # fixtures', 'suffix:.test.ts * # unit fixtures', 'supabase/seed.sql repeated-digits # dev seed'].join(
      '\n',
    ),
  );

  it('matches a directory prefix for any rule', () => {
    expect(isAllowed(allowList, 'e2e/remote-smoke/spec.ts', 'jwt')).toBe(true);
    expect(isAllowed(allowList, 'src/e2e/spec.ts', 'jwt')).toBe(false);
  });

  it('matches a filename suffix', () => {
    expect(isAllowed(allowList, 'src/entities/staff/staff.test.ts', 'pin-assignment')).toBe(true);
    expect(isAllowed(allowList, 'src/entities/staff/staff.ts', 'pin-assignment')).toBe(false);
  });

  it('scopes an entry to a single rule id', () => {
    expect(isAllowed(allowList, 'supabase/seed.sql', 'repeated-digits')).toBe(true);
    expect(isAllowed(allowList, 'supabase/seed.sql', 'jwt')).toBe(false);
  });

  it('rejects an unlisted path', () => {
    expect(isAllowed(allowList, 'src/other.ts', 'jwt')).toBe(false);
  });
});

describe('secret-scan-allow.txt: the pin-env-assignment rule is scoped per-file', () => {
  it('has no suffix: entry for pin-env-assignment (that would exempt every matching file, not just the rule\'s own fixtures)', () => {
    const parsed = parseAllowList(REAL_ALLOW_LIST_TEXT);
    const suffixWide = parsed.filter((e) => e.entry.startsWith('suffix:') && e.rule === 'pin-env-assignment');
    expect(suffixWide).toEqual([]);
  });
});

describe('scanTree', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-secrets-scantree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds an unallowed match, skips an allowed one, skips binaries, and honours the inline marker', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
    writeFileSync(join(dir, 'flagged.md'), `token = "${jwt}"\n`);
    mkdirSync(join(dir, 'allowed-dir'));
    writeFileSync(join(dir, 'allowed-dir', 'note.md'), `token = "${jwt}"\n`);
    writeFileSync(join(dir, 'ignored.md'), `token = "${jwt}" // secret-scan-ignore\n`);
    // A .json extension (in TEXT_EXTS) with raw binary bytes must be skipped, not
    // scanned as if it were text.
    writeFileSync(join(dir, 'data.json'), Buffer.from([0, 1, 2, 3, 0, 255, 0, jwt.charCodeAt(0)]));

    const findings = scanTree({
      root: dir,
      allowListText: 'allowed-dir/ * # test fixture directory\n',
    });

    expect(findings).toEqual([{ path: 'flagged.md', line: 1, rule: 'jwt' }]);
  });

  it('regression guard: a directory-wide allow entry must never blanket-allow every rule under .planning/ or docs/superpowers/', () => {
    // Neither x.md nor y.md is one of the allow-list's specific, already-reviewed
    // entries: a new secret-shaped value dropped into either directory must still
    // be caught by the real, shipped allow-list, not silently passed.
    mkdirSync(join(dir, '.planning', 'notes'), { recursive: true });
    // Built from isolated digit literals, never a contiguous "PIN ... 123457"
    // token in this file's own source, so this test file cannot flag itself.
    const syntheticPin = ['1', '2', '3', '4', '5', '7'].join('');
    writeFileSync(
      join(dir, '.planning', 'notes', 'x.md'),
      `the manager's PIN was ${syntheticPin} and it was changed\n`,
    );
    mkdirSync(join(dir, 'docs', 'superpowers'), { recursive: true });
    const syntheticJwt = `eyJ${'d'.repeat(20)}.eyJ${'e'.repeat(20)}.${'f'.repeat(20)}`;
    writeFileSync(join(dir, 'docs', 'superpowers', 'y.md'), `token = "${syntheticJwt}"\n`);

    const findings = scanTree({ root: dir, allowListText: REAL_ALLOW_LIST_TEXT });

    expect(findings.some((f) => f.path === '.planning/notes/x.md')).toBe(true);
    expect(findings.some((f) => f.path === 'docs/superpowers/y.md' && f.rule === 'jwt')).toBe(true);
  });

  it('regression guard: an all-rules suffix or directory allow entry must never blanket-allow a real-secret-shaped rule under exported code or e2e', () => {
    // A directory-wide `*` entry for a test-file suffix or for e2e/ is meant to
    // absorb synthetic PINs, not an actual JWT/GitHub-token/Anthropic-key shape.
    // These three paths are all covered today by an all-rules allow entry
    // (suffix:.test.ts, or e2e/); scoping those entries to the specific rule ids
    // they need must not blanket-hide a credential-shaped literal that lands in
    // one of these files by mistake.
    mkdirSync(join(dir, 'src'), { recursive: true });
    const syntheticJwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
    writeFileSync(join(dir, 'src', 'b.test.ts'), `const token = "${syntheticJwt}";\n`);

    mkdirSync(join(dir, 'supabase', 'functions', 'x'), { recursive: true });
    const syntheticGithubToken = `ghp_${'x'.repeat(36)}`;
    writeFileSync(join(dir, 'supabase', 'functions', 'x', 'index.test.ts'), `const token = "${syntheticGithubToken}";\n`);

    mkdirSync(join(dir, 'e2e', 'remote-smoke'), { recursive: true });
    const syntheticAnthropicKey = `sk-ant-${'y'.repeat(24)}`;
    writeFileSync(join(dir, 'e2e', 'remote-smoke', 'r.spec.ts'), `const key = "${syntheticAnthropicKey}";\n`);

    const findings = scanTree({ root: dir, allowListText: REAL_ALLOW_LIST_TEXT });

    expect(findings).toHaveLength(3);
    expect(findings.some((f) => f.path === 'src/b.test.ts' && f.rule === 'jwt')).toBe(true);
    expect(findings.some((f) => f.path === 'supabase/functions/x/index.test.ts' && f.rule === 'github-token')).toBe(
      true,
    );
    expect(findings.some((f) => f.path === 'e2e/remote-smoke/r.spec.ts' && f.rule === 'anthropic-key')).toBe(true);
  });

  it(
    'walkDir does not follow a symlinked directory: a loop terminates and a linked directory\'s files are not double-listed',
    (ctx) => {
      const realDir = join(dir, 'real');
      mkdirSync(realDir);
      const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
      writeFileSync(join(realDir, 'secret.md'), `token = "${jwt}"\n`);

      let linked = true;
      try {
        // Directory symlink (Windows: a junction needs no elevated privilege).
        symlinkSync(realDir, join(dir, 'link-to-real'), 'junction');
        // A loop: the linked tree also links back up to an ancestor. Without a
        // symlink guard (lstatSync + skip), a naive statSync-following walker
        // recurses forever.
        symlinkSync(dir, join(realDir, 'loop-back'), 'junction');
      } catch (err) {
        if (err && err.code === 'EPERM') {
          linked = false;
        } else {
          throw err;
        }
      }
      if (!linked) {
        // Creating a symlink is not permitted in this environment (EPERM) —
        // an explicit skip, not a silent pass with no assertion run.
        ctx.skip();
      }

      const findings = scanTree({ root: dir, allowListText: '' });

      // Terminates within the test's own timeout (bounded below) — a naive
      // statSync-following walker would hang here instead.
      const secretHits = findings.filter((f) => f.path.endsWith('secret.md'));
      expect(secretHits).toHaveLength(1);
    },
    5000,
  );

  it('scans .sh scripts and dotfiles such as .npmrc as text', () => {
    const syntheticGithubToken = `ghp_${'z'.repeat(36)}`;
    writeFileSync(join(dir, 'x.sh'), `#!/bin/sh\nTOKEN="${syntheticGithubToken}"\n`);
    writeFileSync(join(dir, '.npmrc'), `//registry.example.invalid/:_authToken=${syntheticGithubToken}\n`);

    const findings = scanTree({ root: dir, allowListText: '' });

    expect(findings.some((f) => f.path === 'x.sh' && f.rule === 'github-token')).toBe(true);
    expect(findings.some((f) => f.path === '.npmrc' && f.rule === 'github-token')).toBe(true);
  });
});

describe('main', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-secrets-main-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 on a clean --root directory', async () => {
    writeFileSync(join(dir, 'clean.md'), 'nothing secret here\n');
    const log = [];
    const code = await main(['--root', dir], { log: (m) => log.push(m), error: () => {} });
    expect(code).toBe(0);
  });

  it('exits 1 and prints "path:line: secret pattern ... (value not shown)" on a finding', async () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
    writeFileSync(join(dir, 'bad.md'), `token = "${jwt}"\n`);
    const log = [];
    const code = await main(['--root', dir], { log: (m) => log.push(m), error: () => {} });
    expect(code).toBe(1);
    expect(log[0]).toBe('bad.md:1: secret pattern "jwt" (value not shown)');
    expect(log.join('\n')).not.toContain(jwt);
  });

  it('exits 2 when --root is given with no directory argument', async () => {
    const errors = [];
    const code = await main(['--root'], { log: () => {}, error: (m) => errors.push(m) });
    expect(code).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });
});

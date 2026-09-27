import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportCustomerTree } from './export-customer-tree.mjs';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/** Every path this exclude list should keep out of an export, mirroring the real file's shape. */
const EXCLUDE_TEXT = ['# fixture exclude list', '.planning', 'customers', 'docs/superpowers', 'HANDOFF.md', ''].join(
  '\n',
);

describe('exportCustomerTree', () => {
  let workDir;
  let repo;
  let excludeFile;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'export-customer-tree-'));
    repo = join(workDir, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);

    mkdirSync(join(repo, '.planning'));
    writeFileSync(join(repo, '.planning', 'x.md'), 'vendor-only planning note\n');
    mkdirSync(join(repo, 'customers'));
    writeFileSync(join(repo, 'customers', 'customers.json'), '[]\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'HANDOFF.md'), 'hand-off notes\n');
    mkdirSync(join(repo, 'docs', 'superpowers'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'superpowers', 'p.md'), 'plan\n');
    // Prefix sibling: "docs/superpowers" must not exclude "docs/superpowers-guide.md".
    writeFileSync(join(repo, 'docs', 'keep.md'), 'keep me\n');
    writeFileSync(join(repo, 'docs', 'superpowers-guide.md'), 'guide, not under docs/superpowers\n');
    writeFileSync(join(repo, 'package.json'), '{}\n');
    mkdirSync(join(repo, 'src-tauri'), { recursive: true });
    writeFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), '{}\n');

    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'fixture commit']);

    excludeFile = join(workDir, 'exclude.txt');
    writeFileSync(excludeFile, EXCLUDE_TEXT);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('exports exactly the non-excluded files, keeping the prefix sibling', () => {
    const out = join(workDir, 'out');
    const result = exportCustomerTree({ repo, ref: 'HEAD', out, excludeFile });

    expect(result.ok).toBe(true);

    function listFiles(dir, base = dir, acc = []) {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) listFiles(full, base, acc);
        else acc.push(full.slice(base.length + 1).split('\\').join('/'));
      }
      return acc.sort();
    }

    expect(listFiles(out)).toEqual(
      ['docs/keep.md', 'docs/superpowers-guide.md', 'package.json', 'src-tauri/tauri.conf.json', 'src/a.ts'].sort(),
    );
  });

  it('refuses a non-empty --out directory', () => {
    const out = join(workDir, 'nonempty-out');
    mkdirSync(out);
    writeFileSync(join(out, 'already-here.txt'), 'x');

    expect(() => exportCustomerTree({ repo, ref: 'HEAD', out, excludeFile })).toThrow(/not empty|non-empty/i);
  });

  it('refuses an --out inside the repository', () => {
    const out = join(repo, 'export-here');
    expect(() => exportCustomerTree({ repo, ref: 'HEAD', out, excludeFile })).toThrow(/inside the repository/i);
  });

  it('fails verification when the extracted tree still contains an excluded path (defense in depth)', () => {
    // Simulates a hypothetical git/tar-level regression: the archive step
    // "succeeds" but the extracted tree still carries an excluded directory.
    // The post-extraction walk must catch this, not just trust the pathspec.
    const out = join(workDir, 'out2');
    const fakeExec = (cmd, _args, opts) => {
      if (cmd === 'git') return Buffer.from('');
      if (cmd === 'tar') {
        mkdirSync(join(opts.cwd, '.planning'), { recursive: true });
        writeFileSync(join(opts.cwd, '.planning', 'unexpected.md'), 'x');
        writeFileSync(join(opts.cwd, 'package.json'), '{}');
        mkdirSync(join(opts.cwd, 'src-tauri'), { recursive: true });
        writeFileSync(join(opts.cwd, 'src-tauri', 'tauri.conf.json'), '{}');
        return Buffer.from('');
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };

    expect(() => exportCustomerTree({ repo, ref: 'HEAD', out, excludeFile, exec: fakeExec })).toThrow(
      /excluded path/i,
    );
  });
});

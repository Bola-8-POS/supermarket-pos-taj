import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { comparePacks, eolKind, exitCodeFor, main, normalizeEol, readGitBlobs, readSqlFiles } from './check-pack-migrations-match.mjs';

describe('comparePacks', () => {
  let pack;
  let repo;
  beforeEach(() => {
    pack = mkdtempSync(join(tmpdir(), 'pm-pack-'));
    repo = mkdtempSync(join(tmpdir(), 'pm-repo-'));
    for (const d of [pack, repo]) {
      writeFileSync(join(d, '20260101000001_a.sql'), 'select 1;\nselect 2;\n');
      writeFileSync(join(d, '20260101000002_b.sql'), 'select 3;\n');
    }
  });
  afterEach(() => {
    rmSync(pack, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  const run = () => comparePacks(readSqlFiles(pack), readSqlFiles(repo));

  it('equal_folders_are_ok', () => {
    const r = run();
    expect(r.ok).toBe(true);
    expect(r.equal).toHaveLength(2);
    expect(r.eolOnly).toEqual([]);
  });

  it('one_changed_byte_is_a_diff', () => {
    writeFileSync(join(pack, '20260101000002_b.sql'), 'select 4;\n');
    const r = run();
    expect(r.ok).toBe(false);
    expect(r.diff).toEqual(['20260101000002_b.sql']);
  });

  it('an_extra_file_in_the_pack_is_flagged', () => {
    writeFileSync(join(pack, '20260101000003_c.sql'), 'select 5;\n');
    expect(run().extra).toEqual(['20260101000003_c.sql']);
  });

  it('a_file_missing_from_the_pack_is_flagged', () => {
    rmSync(join(pack, '20260101000001_a.sql'));
    const r = run();
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['20260101000001_a.sql']);
  });

  it('crlf_pack_vs_lf_repo_is_an_eol_only_difference', () => {
    writeFileSync(join(pack, '20260101000001_a.sql'), 'select 1;\r\nselect 2;\r\n');
    const r = run();
    expect(r.contentOk).toBe(true);
    expect(r.eolOnly).toEqual(['20260101000001_a.sql']);
    expect(r.eol.pack.counts).toEqual({ LF: 1, CRLF: 1, mixed: 0, empty: 0 });
    expect(r.eol.repo.counts).toEqual({ LF: 2, CRLF: 0, mixed: 0, empty: 0 });
    expect(exitCodeFor(r, false)).toBe(0);
    expect(exitCodeFor(r, true)).toBe(1);
  });

  it('a_real_change_in_a_crlf_file_still_fails', () => {
    writeFileSync(join(pack, '20260101000001_a.sql'), 'select 1;\r\nselect 9;\r\n');
    const r = run();
    expect(r.diff).toEqual(['20260101000001_a.sql']);
    expect(exitCodeFor(r, false)).toBe(1);
  });

  it('empty_and_mixed_files_are_classified_and_listed', () => {
    writeFileSync(join(pack, '20260101000003_c.sql'), '');
    writeFileSync(join(repo, '20260101000003_c.sql'), '');
    writeFileSync(join(pack, '20260101000004_d.sql'), 'a\r\nb\nc\r\n');
    writeFileSync(join(repo, '20260101000004_d.sql'), 'a\r\nb\nc\r\n');
    const r = run();
    expect(r.contentOk).toBe(true);
    expect(r.eol.pack.counts.empty).toBe(1);
    expect(r.eol.pack.counts.mixed).toBe(1);
    expect(r.eol.pack.mixed).toEqual(['20260101000004_d.sql']);
    expect(r.eol.repo.mixed).toEqual(['20260101000004_d.sql']);
  });

  it('non_sql_files_are_ignored', () => {
    writeFileSync(join(pack, 'README.md'), 'x');
    expect(run().ok).toBe(true);
  });

  it('main_exit_codes: eol-only is 0, strict is 1, a real change is 1, bad usage is 2', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mkdirSync(join(pack, 'migrations'));
      writeFileSync(join(pack, 'migrations', '20260101000001_a.sql'), 'select 1;\r\nselect 2;\r\n');
      writeFileSync(join(pack, 'migrations', '20260101000002_b.sql'), 'select 3;\r\n');
      expect(main([pack, repo])).toBe(0);
      expect(main([pack, repo, '--strict-eol'])).toBe(1);
      writeFileSync(join(pack, 'migrations', '20260101000002_b.sql'), 'select 8;\r\n');
      expect(main([pack, repo])).toBe(1);
      expect(main([])).toBe(2);
    } finally {
      log.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('eol helpers', () => {
  it('eolKind', () => {
    expect(eolKind(Buffer.from(''))).toBe('empty');
    expect(eolKind(Buffer.from('a\nb\n'))).toBe('LF');
    expect(eolKind(Buffer.from('a'))).toBe('LF');
    expect(eolKind(Buffer.from('a\r\nb\r\n'))).toBe('CRLF');
    expect(eolKind(Buffer.from('a\r\nb\n'))).toBe('mixed');
  });
  it('normalizeEol', () => {
    expect(normalizeEol(Buffer.from('a\r\nb\rc\n')).toString()).toBe('a\nb\rc\n');
  });
});

describe('readGitBlobs', () => {
  it('reads committed blobs (LF) even when the working copy is CRLF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-git-'));
    try {
      const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
      git('init', '-q');
      mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
      writeFileSync(join(dir, 'supabase', 'migrations', '20260101000001_a.sql'), 'select 1;\n');
      writeFileSync(join(dir, 'supabase', 'migrations', '20260101000002_empty.sql'), '');
      git('add', '-A');
      git('commit', '-q', '-m', 'x');
      writeFileSync(join(dir, 'supabase', 'migrations', '20260101000001_a.sql'), 'select 1;\r\n'); // working copy drifts to CRLF
      const blobs = readGitBlobs(dir, 'HEAD');
      expect(Object.keys(blobs)).toEqual(['20260101000001_a.sql', '20260101000002_empty.sql']);
      expect(blobs['20260101000001_a.sql'].toString()).toBe('select 1;\n');
      expect(blobs['20260101000002_empty.sql'].length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

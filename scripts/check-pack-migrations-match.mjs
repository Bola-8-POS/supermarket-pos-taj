/**
 * Content check: a pack's migration files must carry the same content as the repo's supabase/migrations.
 * The till bundles its expected schema level from the repo folder; the store server reports the level of the
 * pack it runs. A pack built from different migration content would make every till refuse to write (07b R1).
 *
 *   node scripts/check-pack-migrations-match.mjs <packDir> [migrationsDir] [--rev <git rev>] [--strict-eol]
 *
 * Pack side: <packDir>/migrations/*.sql from disk.
 * Repo side: by default the committed git blobs of supabase/migrations at --rev (default HEAD), so a Windows
 * working copy with CRLF checkout cannot make a pack look equal when a clean checkout would not. With an explicit
 * [migrationsDir] the repo side is that folder on disk instead.
 *
 * Both sides are CRLF->LF normalised before hashing: line endings alone are not a content difference. They are
 * reported (per-side counts of LF / CRLF / mixed / empty files, the mixed ones listed, and the names whose raw bytes
 * differ only by line ending) and fail the run only with --strict-eol.
 *
 * Exit: 0 identical content, 1 a content difference (DIFF / MISSING / EXTRA) or, with --strict-eol, an EOL-only
 * difference, 2 bad usage. "MISSING" = in the repo, not in the pack. "EXTRA" = in the pack, not in the repo.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_REL = 'supabase/migrations';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** CRLF -> LF. A lone CR is left alone. */
export function normalizeEol(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

/** 'empty' | 'LF' (no CRLF, including a file without any newline) | 'CRLF' (every LF follows a CR) | 'mixed'. */
export function eolKind(buf) {
  if (buf.length === 0) return 'empty';
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (buf[i - 1] === 0x0d) crlf++;
    else lf++;
  }
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'CRLF' : 'LF';
}

/** { 'name.sql': Buffer } for every *.sql file directly inside dir. */
export function readSqlFiles(dir) {
  const out = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) out[name] = readFileSync(join(dir, name));
  return out;
}

/** { 'name.sql': Buffer } of the committed blobs of <relDir> at <rev>. */
export function readGitBlobs(repoRoot, rev, relDir = REPO_REL) {
  const listed = execFileSync('git', ['ls-tree', '--name-only', '-z', `${rev}:${relDir}`], { cwd: repoRoot, maxBuffer: 1 << 26 })
    .toString('utf8')
    .split('\0')
    .filter((n) => n.endsWith('.sql'))
    .sort();
  if (listed.length === 0) return {};
  const input = listed.map((n) => `${rev}:${relDir}/${n}\n`).join('');
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: repoRoot, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git cat-file failed: ${String(r.stderr)}`);
  const buf = r.stdout;
  const out = {};
  let pos = 0;
  for (const name of listed) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, nl).toString('utf8').split(' '); // <sha> blob <size>
    if (header[1] !== 'blob') throw new Error(`not a blob: ${name} (${header.join(' ')})`);
    const size = Number(header[2]);
    out[name] = Buffer.from(buf.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1; // trailing LF after each object
  }
  return out;
}

function tally(files) {
  const counts = { LF: 0, CRLF: 0, mixed: 0, empty: 0 };
  const mixed = [];
  for (const [name, buf] of Object.entries(files)) {
    const k = eolKind(buf);
    counts[k]++;
    if (k === 'mixed') mixed.push(name);
  }
  return { counts, mixed };
}

/** Pure: compares two { name: Buffer } maps on EOL-normalised content and reports the line endings. */
export function comparePacks(pack, repo) {
  const equal = [];
  const diff = [];
  const missing = [];
  const extra = [];
  const eolOnly = [];
  for (const [name, buf] of Object.entries(repo)) {
    if (!(name in pack)) {
      missing.push(name);
      continue;
    }
    const other = pack[name];
    if (sha(normalizeEol(other)) !== sha(normalizeEol(buf))) diff.push(name);
    else {
      equal.push(name);
      if (sha(other) !== sha(buf)) eolOnly.push(name);
    }
  }
  for (const name of Object.keys(pack)) if (!(name in repo)) extra.push(name);
  const contentOk = diff.length + missing.length + extra.length === 0;
  return { equal, diff, missing, extra, eolOnly, eol: { pack: tally(pack), repo: tally(repo) }, contentOk, ok: contentOk };
}

export function exitCodeFor(result, strictEol) {
  if (!result.contentOk) return 1;
  return strictEol && result.eolOnly.length > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const pos = [];
  let rev = 'HEAD';
  let strictEol = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rev') rev = argv[++i] ?? '';
    else if (argv[i] === '--strict-eol') strictEol = true;
    else pos.push(argv[i]);
  }
  return { pos, rev, strictEol };
}

const fmt = (t) => `LF ${t.counts.LF}, CRLF ${t.counts.CRLF}, mixed ${t.counts.mixed}, empty ${t.counts.empty}`;

export function main(argv = process.argv.slice(2), root = ROOT) {
  const { pos, rev, strictEol } = parseArgs(argv);
  const [packDir, repoArg] = pos;
  if (!packDir || !rev) {
    console.error('usage: node scripts/check-pack-migrations-match.mjs <packDir> [migrationsDir] [--rev <git rev>] [--strict-eol]');
    return 2;
  }
  const packMigrations = join(resolve(packDir), 'migrations');
  if (!existsSync(packMigrations)) {
    console.error(`not a folder: ${packMigrations}`);
    return 2;
  }
  let repoFiles;
  let repoLabel;
  if (repoArg) {
    const d = resolve(repoArg);
    if (!existsSync(d)) {
      console.error(`not a folder: ${d}`);
      return 2;
    }
    repoFiles = readSqlFiles(d);
    repoLabel = `folder ${d}`;
  } else {
    try {
      repoFiles = readGitBlobs(root, rev);
    } catch (e) {
      console.error(`cannot read ${REPO_REL} at ${rev}: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    repoLabel = `git blobs at ${rev}`;
  }
  const r = comparePacks(readSqlFiles(packMigrations), repoFiles);
  console.log(`repo side: ${repoLabel}`);
  console.log(`equal (EOL-normalised): ${r.equal.length}`);
  for (const n of r.diff) console.log(`DIFF: ${n}`);
  for (const n of r.missing) console.log(`MISSING (in repo, not in pack): ${n}`);
  for (const n of r.extra) console.log(`EXTRA (in pack, not in repo): ${n}`);
  console.log(`EOL pack: ${fmt(r.eol.pack)}`);
  console.log(`EOL repo: ${fmt(r.eol.repo)}`);
  for (const n of r.eol.pack.mixed) console.log(`EOL mixed (pack): ${n}`);
  for (const n of r.eol.repo.mixed) console.log(`EOL mixed (repo): ${n}`);
  if (r.eolOnly.length > 0) console.log(`INFO: ${r.eolOnly.length} file(s) differ only by line ending (first: ${r.eolOnly[0]})${strictEol ? ' - failing: --strict-eol' : ''}`);
  const code = exitCodeFor(r, strictEol);
  console.log(code === 0 ? 'OK: pack migrations have the same content as the repo' : 'MISMATCH');
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());

/**
 * Secret-shaped literal scanner. Wired into
 * `npm run lint` as `lint:secrets`, run over the customer export in CI and
 * before every customer push, and runnable by hand against any directory.
 *
 * Usage:
 *   node scripts/check-secrets.mjs                 scans this git repo (git ls-files)
 *   node scripts/check-secrets.mjs --root <dir>     walks a plain directory instead
 *
 * Findings never carry the matched value: `path:line: secret pattern "<rule>"
 * (value not shown)`, one per line, plus a summary line. Exit 1 on any finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanText } from './lib/secret-rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOW_LIST_PATH = join(ROOT, 'scripts', 'lib', 'secret-scan-allow.txt');

// Portal's TEXT_EXTS plus this repo's own script/config/native file types.
const TEXT_EXTS = new Set([
  '.md',
  '.mdx',
  '.json',
  '.txt',
  '.yml',
  '.yaml',
  '.csv',
  '.sql',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.toml',
  '.ps1',
  '.psm1',
  '.nsh',
  '.rs',
  '.cjs',
  '.env.example',
  '.cs',
  '.xml',
  '.svg',
  '.sh',
  '.py',
  '.jsx',
  '.ini',
  '.cfg',
  '.npmrc',
  '.firebaserc',
]);
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git']);

function toPosix(p) {
  return p.split(sep).join('/');
}

// A dotfile with no further extension (.npmrc, .firebaserc, .env.example) has
// no text after its last dot to slice off: its whole basename IS the "extension".
const DOTFILE_EXTS = new Set(['.env.example', '.npmrc', '.firebaserc']);

function extOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (DOTFILE_EXTS.has(base)) return base;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot);
}

/** A quick, dependency-free binary sniff: a NUL byte in the first 8000 bytes. */
function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Parse `scripts/lib/secret-scan-allow.txt`'s format: one entry per line,
 * `<path-prefix-or-exact-or-suffix:...> <rule-id|*> # reason`. Blank lines and
 * lines starting with `#` are ignored. A malformed line (no rule token) is
 * ignored rather than crashing the scan.
 * @param {string} text
 * @returns {{ entry: string, rule: string, reason: string }[]}
 */
export function parseAllowList(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const hashIndex = line.indexOf('#');
    const body = (hashIndex === -1 ? line : line.slice(0, hashIndex)).trim();
    const reason = hashIndex === -1 ? '' : line.slice(hashIndex + 1).trim();
    const parts = body.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const rule = parts[parts.length - 1];
    const entry = parts.slice(0, -1).join(' ');
    entries.push({ entry, rule, reason });
  }
  return entries;
}

/**
 * @param {{ entry: string, rule: string }[]} allowList
 * @param {string} path repo-relative, forward slashes
 * @param {string} rule
 * @returns {boolean}
 */
export function isAllowed(allowList, path, rule) {
  for (const a of allowList) {
    if (a.rule !== '*' && a.rule !== rule) continue;
    if (a.entry.startsWith('suffix:')) {
      if (path.endsWith(a.entry.slice('suffix:'.length))) return true;
    } else if (a.entry.endsWith('/')) {
      if (path === a.entry.slice(0, -1) || path.startsWith(a.entry)) return true;
    } else if (path === a.entry) {
      return true;
    }
  }
  return false;
}

function listGitFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean).map(toPosix);
}

function walkDir(root, dir = root, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(root, full, acc);
    } else if (st.isFile()) {
      acc.push(toPosix(relative(root, full)));
    }
  }
  return acc;
}

/**
 * @param {{ root: string, allowListText?: string, listFiles?: (root: string) => string[] }} opts
 * @returns {{ path: string, line: number, rule: string }[]}
 */
export function scanTree({ root, allowListText = '', listFiles }) {
  const allowList = parseAllowList(allowListText);
  const paths = (listFiles ?? walkDir)(root);
  const findings = [];
  for (const path of paths) {
    if (!TEXT_EXTS.has(extOf(path))) continue;
    const full = join(root, ...path.split('/'));
    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      continue; // e.g. a broken symlink
    }
    if (looksBinary(buf)) continue;
    for (const finding of scanText(buf.toString('utf8'), path)) {
      if (isAllowed(allowList, path, finding.rule)) continue;
      findings.push({ path, line: finding.line, rule: finding.rule });
    }
  }
  return findings;
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, error?: (s: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  const rootFlagIndex = argv.indexOf('--root');
  const useRoot = rootFlagIndex !== -1;
  const root = useRoot ? argv[rootFlagIndex + 1] : ROOT;
  if (useRoot && !root) {
    error('check-secrets: --root requires a directory argument');
    return 2;
  }

  const allowListText = readFileSync(ALLOW_LIST_PATH, 'utf8');
  const findings = scanTree({
    root,
    allowListText,
    listFiles: useRoot ? undefined : listGitFiles,
  });

  for (const f of findings) {
    log(`${f.path}:${f.line}: secret pattern "${f.rule}" (value not shown)`);
  }
  log(`check-secrets: ${findings.length} finding(s) in ${root}`);
  return findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}

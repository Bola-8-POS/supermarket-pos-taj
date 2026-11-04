/**
 * Export a filtered snapshot of the source tree for a customer release:
 * `git archive` with a tracked exclude list, extracted with `tar` reading from
 * stdin (never a drive-letter path argument — see the tar fact in the plan).
 *
 * Usage:
 *   node scripts/export-customer-tree.mjs --ref <tree-ish> --out <dir> \
 *     [--repo <dir>] [--exclude-file scripts/lib/customer-export-exclude.txt]
 *
 * Prints `exported <n> files, excluded <k> paths` and exits 1 on any
 * verification failure (an excluded path present, package.json or
 * src-tauri/tauri.conf.json missing, or an unexpected .env* file present).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_EXCLUDE_FILE = join(ROOT, 'scripts', 'lib', 'customer-export-exclude.txt');

function toPosix(p) {
  return p.split(sep).join('/');
}

function readExcludePaths(excludeFile) {
  return readFileSync(excludeFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean);
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base, acc);
    } else {
      acc.push(toPosix(relative(base, full)));
    }
  }
  return acc;
}

/**
 * @param {{ repo?: string, ref: string, out: string, excludeFile?: string, exec?: typeof execFileSync }} opts
 * @returns {{ ok: true, exportedCount: number, excludedCount: number }}
 */
export function exportCustomerTree({ repo = ROOT, ref, out, excludeFile = DEFAULT_EXCLUDE_FILE, exec = execFileSync }) {
  const repoAbs = resolve(repo);
  const outAbs = resolve(out);

  if (outAbs === repoAbs || outAbs.startsWith(repoAbs + sep)) {
    throw new Error(`--out '${out}' is inside the repository`);
  }
  if (existsSync(outAbs)) {
    if (readdirSync(outAbs).length > 0) {
      throw new Error(`--out '${out}' is not empty`);
    }
  } else {
    mkdirSync(outAbs, { recursive: true });
  }

  const excludePaths = readExcludePaths(excludeFile);
  const archiveArgs = [
    '-C',
    repoAbs,
    'archive',
    '--format=tar',
    ref,
    '--',
    '.',
    ...excludePaths.map((p) => `:(exclude)${p}`),
  ];
  const buffer = exec('git', archiveArgs, { maxBuffer: 512 * 1024 * 1024 });
  // Never a drive-letter path argument here: GNU tar on this machine treats a
  // `C:\...`-shaped argument as a remote host. Pipe on stdin with `cwd` set,
  // which works with both GNU tar and bsdtar.
  exec('tar', ['-x', '-f', '-'], { cwd: outAbs, input: buffer, maxBuffer: 512 * 1024 * 1024 });

  const files = walk(outAbs);

  const stray = files.find((f) => excludePaths.some((p) => f === p || f.startsWith(`${p}/`)));
  if (stray) {
    throw new Error(`exported tree contains an excluded path: ${stray}`);
  }
  if (!files.includes('package.json')) {
    throw new Error('exported tree is missing package.json');
  }
  if (!files.includes('src-tauri/tauri.conf.json')) {
    throw new Error('exported tree is missing src-tauri/tauri.conf.json');
  }
  const envHit = files.find((f) => {
    const base = f.slice(f.lastIndexOf('/') + 1);
    return base !== '.env.example' && /^\.env(\..*)?$/.test(base);
  });
  if (envHit) {
    throw new Error(`exported tree carries an env file: ${envHit}`);
  }

  return { ok: true, exportedCount: files.length, excludedCount: excludePaths.length };
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, error?: (s: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const ref = get('--ref');
  const out = get('--out');
  const repo = get('--repo') ?? ROOT;
  const excludeFile = get('--exclude-file') ?? DEFAULT_EXCLUDE_FILE;

  if (!ref || !out) {
    error('export-customer-tree: --ref <tree-ish> and --out <dir> are required');
    return 2;
  }

  try {
    const result = exportCustomerTree({ repo, ref, out, excludeFile });
    log(`exported ${result.exportedCount} files, excluded ${result.excludedCount} paths`);
    return 0;
  } catch (err) {
    error(`export-customer-tree: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}

// Node replacement for the pwsh-only deno:lock command, plus a new `check`
// sub-command that type-checks every edge-function entrypoint. Both
// sub-commands collect the same file list via collectEntrypoints, so
// "every .ts file under supabase/functions" is defined in exactly one
// place instead of once per shell.
//
// Usage:
//   node scripts/deno-functions.mjs check
//   node scripts/deno-functions.mjs lock [--frozen]
//
// Exit code: whatever the spawned `deno` process exits with.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FUNCTIONS_DIR = join(repoRoot, 'supabase', 'functions');
const DENO_CONFIG = join('supabase', 'functions', 'deno.json');

function toPosix(p) {
  return p.split('\\').join('/');
}

// deno.lock/deno.json never end in .ts, so this Set is a defensive,
// explicitly-named exclusion rather than load-bearing filtering.
const EXCLUDED_NAMES = new Set(['deno.lock', 'deno.json']);

/**
 * Every .ts file under `root`, recursive, sorted, full (absolute) paths --
 * matches the pwsh original's `Get-ChildItem -Recurse | % FullName` shape.
 * @param {string} root
 * @returns {string[]}
 */
export function collectEntrypoints(root) {
  const acc = [];
  walk(root);
  return acc.sort();

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !EXCLUDED_NAMES.has(entry.name)) {
        acc.push(full);
      }
    }
  }
}

/**
 * @param {{ run?: typeof spawnSync }} deps
 * @returns {number}
 */
function runCheck(deps = {}) {
  const run = deps.run ?? spawnSync;
  const files = collectEntrypoints(DEFAULT_FUNCTIONS_DIR);
  const result = run('deno', ['check', '--config', toPosix(DENO_CONFIG), ...files], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/**
 * @param {string[]} args
 * @param {{ run?: typeof spawnSync }} deps
 * @returns {number}
 */
function runLock(args, deps = {}) {
  const run = deps.run ?? spawnSync;
  const frozen = args.includes('--frozen');
  const files = collectEntrypoints(DEFAULT_FUNCTIONS_DIR);
  const result = run(
    'deno',
    ['install', '--config', toPosix(DENO_CONFIG), ...(frozen ? ['--frozen'] : []), '--entrypoint', ...files],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return result.status ?? 1;
}

/**
 * @param {string[]} argv
 * @param {{ run?: typeof spawnSync, error?: (...a: unknown[]) => void }} deps
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, deps = {}) {
  const error = deps.error ?? console.error;
  const [cmd, ...rest] = argv;
  if (cmd === 'check') return runCheck(deps);
  if (cmd === 'lock') return runLock(rest, deps);
  error(`deno-functions: unknown command '${cmd}' (expected check|lock)`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}

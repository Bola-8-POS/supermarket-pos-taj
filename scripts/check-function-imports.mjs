// Fails when an edge function under supabase/functions/ imports a remote
// module that floats (no exact version), comes from a host other than
// esm.sh/deno.land/npm:/jsr:, or disagrees with the rest of the tree on the
// version or host used for the same package (dependency-free: node: built-ins
// + a whole-file regex scan, same shape as check-functions-config.mjs).
//
// Usage: node scripts/check-function-imports.mjs [--dir <functions dir>]
//
// Exit codes: 0 clean; 1 one or more violations.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FUNCTIONS_DIR = join(repoRoot, 'supabase', 'functions');

// Whole-file (not per-line) so a Prettier-wrapped multi-line import still
// matches: `(?:^|;)` anchors each statement's start, `[^;]*?` (lazy) crosses
// newlines without a dotAll dot since it's a negated class.
const STATIC_IMPORT_RE = /(?:^|;)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gms;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]/g;

const ALLOWED_HOST_RE = /^(https:\/\/esm\.sh\/|https:\/\/deno\.land\/|npm:|jsr:)/;

// Loose extraction (for grouping): captures a package name and whatever
// follows the version-marking `@`, even when that value isn't an exact
// semver (so a floating `@2` still groups with `@2.49.1`).
const ESM_RE = /^https:\/\/esm\.sh\/((?:@[^/@]+\/[^/@]+)|[^/@]+)@([^/]+)/;
const DENO_X_RE = /^https:\/\/deno\.land\/x\/([^/@]+)@([^/]+)/;
const DENO_STD_RE = /^https:\/\/deno\.land\/std@([^/]+)\//;
const NPM_RE = /^npm:((?:@[^/@]+\/[^/@]+)|[^/@]+)@([^/]+)/;
const JSR_RE = /^jsr:((?:@[^/@]+\/[^/@]+)|[^/@]+)@([^/]+)/;

const EXACT_VERSION_RE = /^v?\d+\.\d+\.\d+/;

function toPosix(p) {
  return p.split('\\').join('/');
}

/** @returns {{ packageName: string, host: string, version: string } | null} */
function normalizeSpecifier(specifier) {
  let m = ESM_RE.exec(specifier);
  if (m) return { packageName: m[1], host: 'esm.sh', version: m[2] };
  m = DENO_STD_RE.exec(specifier);
  if (m) return { packageName: 'std', host: 'deno.land', version: m[1] };
  m = DENO_X_RE.exec(specifier);
  if (m) return { packageName: m[1], host: 'deno.land/x', version: m[2] };
  m = NPM_RE.exec(specifier);
  if (m) return { packageName: m[1], host: 'npm', version: m[2] };
  m = JSR_RE.exec(specifier);
  if (m) return { packageName: m[1], host: 'jsr', version: m[2] };
  return null;
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

// node: built-ins are never remote, so they skip the allowed-host/exact-version
// checks the same way a relative specifier does.
function isLocal(specifier) {
  return isRelative(specifier) || specifier.startsWith('node:');
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * @param {Map<string, string>} files map of posix-relative path -> file text
 * @returns {{ violations: Array<{file: string, line: number, rule: string, specifier: string}>, importLineCount: number, remoteLineCount: number }}
 */
export function checkImports(files) {
  /** @type {Array<{file: string, line: number, rule: string, specifier: string}>} */
  const violations = [];
  /** @type {Array<{file: string, line: number, specifier: string}>} */
  const remoteEntries = [];
  let importLineCount = 0;
  let remoteLineCount = 0;

  for (const [file, text] of files) {
    /** @type {Array<{ index: number, specifier: string }>} */
    const matches = [];

    for (const re of [STATIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // m.index is the whole-file pattern's match start (the preceding `;`
        // or line start), not the `import`/`export` keyword itself, so walk
        // forward to the keyword before turning the position into a line
        // number (see finding N-1).
        const keywordOffset = m[0].search(/\b(?:import|export)\b/);
        matches.push({ index: m.index + keywordOffset, specifier: m[1] });
      }
    }
    matches.sort((a, b) => a.index - b.index);

    for (const { index, specifier } of matches) {
      importLineCount++;
      const lineNo = lineNumberAt(text, index);
      if (isLocal(specifier)) continue;

      remoteLineCount++;
      remoteEntries.push({ file, line: lineNo, specifier });

      if (!ALLOWED_HOST_RE.test(specifier)) {
        violations.push({ file, line: lineNo, rule: 'allowed-host', specifier });
        continue;
      }

      const normalized = normalizeSpecifier(specifier);
      if (!normalized || !EXACT_VERSION_RE.test(normalized.version)) {
        violations.push({ file, line: lineNo, rule: 'exact-version', specifier });
      }
    }
  }

  // one-version: group every normalizable remote specifier by package name;
  // flag every occurrence in a group whose (version, host) pairs aren't all
  // identical.
  const groups = new Map();
  for (const entry of remoteEntries) {
    const normalized = normalizeSpecifier(entry.specifier);
    if (!normalized) continue;
    const list = groups.get(normalized.packageName) ?? [];
    list.push({ ...entry, ...normalized });
    groups.set(normalized.packageName, list);
  }
  for (const group of groups.values()) {
    const distinctPairs = new Set(group.map((g) => `${g.host}@${g.version}`));
    if (distinctPairs.size > 1) {
      for (const g of group) {
        violations.push({ file: g.file, line: g.line, rule: 'one-version', specifier: g.specifier });
      }
    }
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));

  return { violations, importLineCount, remoteLineCount };
}

/** Recursively reads every .ts file under `dir` into a Map keyed by its
 * posix path relative to `dir`. No symlink handling: supabase/functions is a
 * plain source tree, not an untrusted export (see scripts/check-secrets.mjs
 * for the walker that does need it). */
export function walkTsFiles(dir, base = dir, acc = new Map()) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, base, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.set(toPosix(relative(base, full)), readFileSync(full, 'utf8'));
    }
  }
  return acc;
}

function parseArgv(argv) {
  const opts = { dir: DEFAULT_FUNCTIONS_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') opts.dir = argv[++i];
  }
  return opts;
}

/**
 * @param {string[]} argv
 * @param {{ log?: (...a: unknown[]) => void, error?: (...a: unknown[]) => void }} deps
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const { dir } = parseArgv(argv);

  const files = walkTsFiles(dir);
  const { violations, importLineCount, remoteLineCount } = checkImports(files);

  if (violations.length > 0) {
    for (const v of violations) {
      error(`${v.file}:${v.line}: ${v.rule} ${v.specifier}`);
    }
    error(`check-function-imports: ${violations.length} violation(s)`);
    return 1;
  }

  log(`check-function-imports: ok (${importLineCount} import lines, ${remoteLineCount} remote)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}

/**
 * Builds the separate local-assistant installer (assistant-installer/installer.nsi) from pinned artifacts.
 *
 * Usage:
 *   node scripts/assistant-build-installer.mjs --artifacts <dir> --out <dir> (--allow-candidate | --release) [--no-nsis]
 *       [--config assistant-installer/assistant.config.json]
 *
 *   --artifacts  folder holding the runtime zip and the model GGUF named in the config (downloads live outside the
 *                repo, e.g. E:/cache/assistant-artifacts)
 *   --out        folder for the stage dir, resolved-config.json and the installer exe
 *   --allow-candidate  build from a config whose status is "candidate"; artifacts without a pinned sha256 are hashed
 *                and recorded in <out>/resolved-config.json (the committed config is never rewritten)
 *   --release    refuses unless the config status is "approved" and every artifact sha256 is pinned and matches
 *   --no-nsis    stop after signing (the tests use this); makensis is found via TAURI_NSIS_DIR or
 *                %LOCALAPPDATA%/tauri/NSIS/makensis.exe
 *
 * The manifest lists every file with its SHA-256 and is signed with the Tauri updater key
 * (`tauri signer sign`; the key comes from TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH, plus
 * TAURI_SIGNING_PRIVATE_KEY_PASSWORD; this script only checks that one is set and never prints or stores it).
 * The whole install dir must stay under INSTALL_BUDGET_BYTES, the same constant as src-tauri
 * (commands/assistant/manifest.rs). The installer is never run on the dev PC: Windows Sandbox only (Plan 29-04).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG = join(ROOT, 'assistant-installer', 'assistant.config.json');
const NSI = join(ROOT, 'assistant-installer', 'installer.nsi');

/** Same value as INSTALL_BUDGET_BYTES in src-tauri/src/commands/assistant/manifest.rs: strictly under 1,000,000,000 bytes. */
export const INSTALL_BUDGET_BYTES = 1_000_000_000;
/** Room kept for uninstall.exe, which NSIS writes at install time and no manifest can list. */
export const UNINSTALLER_RESERVE_BYTES = 1_000_000;
/** The server binary the Rust side starts; always a listed file. */
export const RUNTIME_EXE = 'runtime/llama-server.exe';

const posix = (p) => p.split(sep).join('/');

export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolveHash(h.digest('hex')));
  });
}

function walkFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, base, out);
    else if (e.isFile()) out.push({ path: posix(relative(base, full)), full });
  }
  return out;
}

/**
 * Hashes every file under `stageDir` (except manifest.json and its signature), sums the bytes, refuses OVER_BUDGET,
 * and returns the deterministic manifest object (sorted file list, fixed key order) plus its serialized text.
 * `sizeOf(fullPath, realLength)` is injectable so tests need no 1 GB file.
 */
export async function buildManifest(stageDir, config, { sizeOf = (_p, len) => len } = {}) {
  const files = walkFiles(stageDir)
    .filter((f) => f.path !== 'manifest.json' && f.path !== 'manifest.json.sig')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const counted = files.reduce((n, f) => n + sizeOf(f.full, statSync(f.full).size), 0);
  if (counted + UNINSTALLER_RESERVE_BYTES >= INSTALL_BUDGET_BYTES) {
    throw new Error(`OVER_BUDGET: ${counted} bytes of files (+ ${UNINSTALLER_RESERVE_BYTES} reserve) is not under ${INSTALL_BUDGET_BYTES}`);
  }
  const modelFile = `models/${config.model.file}`;
  if (!files.some((f) => f.path === RUNTIME_EXE)) throw new Error(`RUNTIME_EXE_MISSING: ${RUNTIME_EXE} is not in the stage dir`);
  if (!files.some((f) => f.path === modelFile)) throw new Error(`MODEL_MISSING: ${modelFile} is not in the stage dir`);
  const entries = [];
  for (const f of files) {
    entries.push({ path: f.path, sha256: await sha256File(f.full), bytes: statSync(f.full).size });
  }
  const manifest = {
    schema_version: 1,
    runtime_tag: config.runtime.tag,
    model_id: config.model.id,
    model_file: modelFile,
    files: entries,
    total_bytes: entries.reduce((n, e) => n + e.bytes, 0),
    server_args: config.server_args,
    request: config.request,
    profile: config.profile,
  };
  return { manifest, text: JSON.stringify(manifest), countedBytes: counted };
}

/** `--release` needs an approved config; a candidate needs `--allow-candidate`. */
export function assertMode(config, { release, allowCandidate }) {
  if (release === allowCandidate) throw new Error('USAGE: pass exactly one of --release or --allow-candidate');
  if (release && config.status !== 'approved') throw new Error(`NOT_APPROVED: config status is "${config.status}", a release build needs "approved"`);
}

/** Signs `file` with `tauri signer sign`; the signature lands in `<file>.sig`. The key never passes through this script. */
export function signFile(file, env = process.env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    throw new Error('SIGNING_KEY_MISSING: set TAURI_SIGNING_PRIVATE_KEY (or _PATH) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  }
  const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
  // stdout is discarded: it echoes the public signature, which is fine, but nothing here needs it.
  execFileSync(process.execPath, [cli, 'signer', 'sign', file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (!existsSync(`${file}.sig`)) throw new Error('SIGN_FAILED: no .sig was written');
}

/** Extracts a zip with bsdtar (`tar` ships with Windows 10+); never a drive-letter-first GNU tar. */
export function unzipWithTar(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zip, '-C', dest], { stdio: 'ignore' });
}

async function pinArtifact(label, path, expected, { release }) {
  if (!existsSync(path)) throw new Error(`ARTIFACT_MISSING: ${label} not found at ${path}`);
  const actual = await sha256File(path);
  if (expected == null) {
    if (release) throw new Error(`UNPINNED_ARTIFACT: ${label} has no sha256 in the config`);
    return actual;
  }
  if (expected.toLowerCase() !== actual) throw new Error(`ARTIFACT_HASH_MISMATCH: ${label}`);
  return actual;
}

function findMakensis(env) {
  const candidates = [env.TAURI_NSIS_DIR && join(env.TAURI_NSIS_DIR, 'makensis.exe'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe')].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('MAKENSIS_MISSING: set TAURI_NSIS_DIR or install the Tauri NSIS toolset');
  return found;
}

/**
 * The whole build. `unzip` is injectable for tests. Returns { stageDir, manifest, installer }.
 */
export async function build({ artifacts, out, config, release = false, allowCandidate = false, noNsis = false, unzip = unzipWithTar, env = process.env }) {
  assertMode(config, { release, allowCandidate });
  const runtimeZip = join(artifacts, config.runtime.zip);
  const modelPath = join(artifacts, config.model.file);
  const resolved = structuredClone(config);
  resolved.runtime.sha256 = await pinArtifact('runtime zip', runtimeZip, config.runtime.sha256, { release });
  resolved.model.sha256 = await pinArtifact('model', modelPath, config.model.sha256, { release });

  const stageDir = join(out, 'stage');
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'models'), { recursive: true });
  unzip(runtimeZip, join(stageDir, 'runtime'));
  copyFileSync(modelPath, join(stageDir, 'models', config.model.file));

  const { manifest, text } = await buildManifest(stageDir, config);
  const manifestPath = join(stageDir, 'manifest.json');
  writeFileSync(manifestPath, text);
  signFile(manifestPath, env);
  writeFileSync(join(out, 'resolved-config.json'), JSON.stringify(resolved, null, 2) + '\n');

  // the finished dir (manifest and signature included) must still fit with the uninstaller's reserve
  const total = walkFiles(stageDir).reduce((n, f) => n + statSync(f.full).size, 0);
  if (total + UNINSTALLER_RESERVE_BYTES >= INSTALL_BUDGET_BYTES) throw new Error(`OVER_BUDGET: stage dir is ${total} bytes`);

  let installer = null;
  if (!noNsis) {
    installer = join(out, `SupermarketPOSAssistant-${config.version}-${config.runtime.tag}.exe`);
    execFileSync(findMakensis(env), [`/DSTAGE_DIR=${stageDir}`, `/DOUT_FILE=${installer}`, `/DVERSION=${config.version}`, NSI], { stdio: 'inherit' });
  }
  return { stageDir, manifest, installer };
}

function parseArgs(argv) {
  const opts = { release: false, allowCandidate: false, noNsis: false, config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artifacts') opts.artifacts = resolve(argv[++i]);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--config') opts.config = resolve(argv[++i]);
    else if (a === '--release') opts.release = true;
    else if (a === '--allow-candidate') opts.allowCandidate = true;
    else if (a === '--no-nsis') opts.noNsis = true;
    else throw new Error(`USAGE: unknown argument ${a}`);
  }
  if (!opts.artifacts || !opts.out) throw new Error('USAGE: --artifacts <dir> and --out <dir> are required');
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const config = JSON.parse(readFileSync(opts.config, 'utf8'));
    mkdirSync(opts.out, { recursive: true });
    const r = await build({ ...opts, config });
    console.log(`assistant installer: ${r.manifest.files.length} files, ${r.manifest.total_bytes} bytes listed${r.installer ? `, ${r.installer}` : ' (nsis skipped)'}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

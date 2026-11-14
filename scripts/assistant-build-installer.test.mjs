import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyManifestSignature } from '../store-server/pack/build/lib/minisign.mjs';

import {
  INSTALL_BUDGET_BYTES,
  RUNTIME_EXE,
  UNINSTALLER_RESERVE_BYTES,
  assertMode,
  build,
  buildManifest,
  signFile,
} from './assistant-build-installer.mjs';

const ROOT = join(import.meta.dirname, '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const CONFIG = {
  status: 'candidate',
  version: '0.0.1',
  runtime: { tag: 'b0000', zip: 'rt.zip', zip_bytes: 3, sha256: null },
  model: { id: 'test-model', file: 'm.gguf', bytes: 10, sha256: null, license: 'Apache-2.0' },
  server_args: ['--n-predict', '160', '--no-slots'],
  request: { max_tokens: 160, timeout_ms: 8000, extra: { chat_template_kwargs: { enable_thinking: false } } },
  profile: { threads_max: 4, ctx_size: 2048, cpu_rate_percent: 50, process_memory_limit_bytes: 1_400_000_000, min_available_memory_bytes: 1_500_000_000, sleep_idle_seconds: 300 },
};

let tmp;
let keyEnv;
let pubkey;

/** A stage dir with the two required files plus an extra runtime dll. */
function makeStage(name) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'models'), { recursive: true });
  writeFileSync(join(dir, RUNTIME_EXE), 'fake-exe');
  writeFileSync(join(dir, 'runtime', 'ggml.dll'), 'dll');
  writeFileSync(join(dir, 'models', 'm.gguf'), 'fake-model');
  return dir;
}

/** Artifacts dir holding a "zip" (the injected unzip ignores its bytes) and the model. */
function makeArtifacts(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rt.zip'), 'zip');
  writeFileSync(join(dir, 'm.gguf'), 'fake-model');
  return dir;
}
const fakeUnzip = (_zip, dest) => {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'llama-server.exe'), 'fake-exe');
  writeFileSync(join(dest, 'ggml.dll'), 'dll');
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'assistant-installer-'));
  const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
  const keyPath = join(tmp, 'test.key');
  // a throwaway key pair per run; never the real updater key
  execFileSync(process.execPath, [cli, 'signer', 'generate', '--ci', '-p', '', '-w', keyPath], { stdio: 'ignore' });
  pubkey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  keyEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
}, 60_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('buildManifest', () => {
  it('hashes every file, sorts the list and is byte-for-byte deterministic', async () => {
    const stage = makeStage('det');
    const a = await buildManifest(stage, CONFIG);
    const b = await buildManifest(stage, CONFIG);
    expect(a.text).toBe(b.text);
    expect(a.manifest.files.map((f) => f.path)).toEqual(['models/m.gguf', 'runtime/ggml.dll', 'runtime/llama-server.exe']);
    expect(a.manifest.files[0]).toEqual({ path: 'models/m.gguf', sha256: sha('fake-model'), bytes: 10 });
    expect(a.manifest.total_bytes).toBe(10 + 3 + 8);
    expect(a.manifest.model_file).toBe('models/m.gguf');
    expect(a.manifest).toMatchObject({ schema_version: 1, runtime_tag: 'b0000', model_id: 'test-model', server_args: CONFIG.server_args });
  });

  it('refuses OVER_BUDGET without a 1 GB file on disk', async () => {
    const stage = makeStage('big');
    const huge = (p, len) => (p.endsWith('m.gguf') ? INSTALL_BUDGET_BYTES : len);
    await expect(buildManifest(stage, CONFIG, { sizeOf: huge })).rejects.toThrow('OVER_BUDGET');
    const edge = (p, len) => (p.endsWith('m.gguf') ? INSTALL_BUDGET_BYTES - UNINSTALLER_RESERVE_BYTES - 11 : len);
    await expect(buildManifest(stage, CONFIG, { sizeOf: edge })).rejects.toThrow('OVER_BUDGET');
    const fits = (p, len) => (p.endsWith('m.gguf') ? INSTALL_BUDGET_BYTES - UNINSTALLER_RESERVE_BYTES - 100 : len);
    await expect(buildManifest(stage, CONFIG, { sizeOf: fits })).resolves.toBeTruthy();
  });

  it('refuses a stage dir without the server binary or the model', async () => {
    const stage = makeStage('nomodel');
    rmSync(join(stage, 'models', 'm.gguf'));
    await expect(buildManifest(stage, CONFIG)).rejects.toThrow('MODEL_MISSING');
    const stage2 = makeStage('noexe');
    rmSync(join(stage2, RUNTIME_EXE));
    await expect(buildManifest(stage2, CONFIG)).rejects.toThrow('RUNTIME_EXE_MISSING');
  });
});

describe('assertMode', () => {
  it('refuses --release while the config status is not approved', () => {
    expect(() => assertMode(CONFIG, { release: true, allowCandidate: false })).toThrow('NOT_APPROVED');
    expect(() => assertMode({ ...CONFIG, status: 'approved' }, { release: true, allowCandidate: false })).not.toThrow();
    expect(() => assertMode(CONFIG, { release: false, allowCandidate: true })).not.toThrow();
  });
  it('needs exactly one mode flag', () => {
    expect(() => assertMode(CONFIG, { release: false, allowCandidate: false })).toThrow('USAGE');
    expect(() => assertMode(CONFIG, { release: true, allowCandidate: true })).toThrow('USAGE');
  });
});

describe('signFile', () => {
  it('refuses to run without a signing key and says which variable to set', () => {
    const env = { ...process.env };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    expect(() => signFile(join(tmp, 'nothing'), env)).toThrow('SIGNING_KEY_MISSING');
  });
});

describe('build (no NSIS)', () => {
  it('stages, writes a manifest the updater key verifies, and records pinned hashes for a candidate', async () => {
    const out = join(tmp, 'out1');
    mkdirSync(out, { recursive: true });
    const r = await build({ artifacts: makeArtifacts('art1'), out, config: CONFIG, allowCandidate: true, noNsis: true, unzip: fakeUnzip, env: keyEnv });
    expect(r.installer).toBeNull();
    const manifestBytes = readFileSync(join(r.stageDir, 'manifest.json'));
    const sig = readFileSync(join(r.stageDir, 'manifest.json.sig'), 'utf8');
    expect(verifyManifestSignature(manifestBytes, sig, pubkey)).toMatch(/file:manifest\.json$/);
    expect(JSON.parse(manifestBytes.toString()).files.map((f) => f.path)).toContain(RUNTIME_EXE);
    const resolved = JSON.parse(readFileSync(join(out, 'resolved-config.json'), 'utf8'));
    expect(resolved.model.sha256).toBe(sha('fake-model'));
    expect(resolved.runtime.sha256).toBe(sha('zip'));
    expect(CONFIG.model.sha256, 'the input config is never mutated').toBeNull();
  }, 60_000);

  it('a tampered manifest no longer verifies', async () => {
    const out = join(tmp, 'out2');
    mkdirSync(out, { recursive: true });
    const r = await build({ artifacts: makeArtifacts('art2'), out, config: CONFIG, allowCandidate: true, noNsis: true, unzip: fakeUnzip, env: keyEnv });
    const edited = Buffer.from(readFileSync(join(r.stageDir, 'manifest.json'), 'utf8').replace('b0000', 'b0001'));
    expect(() => verifyManifestSignature(edited, readFileSync(join(r.stageDir, 'manifest.json.sig'), 'utf8'), pubkey)).toThrow();
  }, 60_000);

  it('--release refuses a candidate config and an unpinned artifact; a wrong pin is a hash mismatch', async () => {
    const out = join(tmp, 'out3');
    mkdirSync(out, { recursive: true });
    const art = makeArtifacts('art3');
    const common = { artifacts: art, out, noNsis: true, unzip: fakeUnzip, env: keyEnv };
    await expect(build({ ...common, config: CONFIG, release: true })).rejects.toThrow('NOT_APPROVED');
    await expect(build({ ...common, config: { ...CONFIG, status: 'approved' }, release: true })).rejects.toThrow('UNPINNED_ARTIFACT');
    const wrong = { ...CONFIG, model: { ...CONFIG.model, sha256: sha('something else') } };
    await expect(build({ ...common, config: wrong, allowCandidate: true })).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
  }, 60_000);

  it('reports a missing artifact by name', async () => {
    const out = join(tmp, 'out4');
    mkdirSync(out, { recursive: true });
    await expect(build({ artifacts: join(tmp, 'empty'), out, config: CONFIG, allowCandidate: true, noNsis: true, unzip: fakeUnzip, env: keyEnv })).rejects.toThrow('ARTIFACT_MISSING');
  });
});

describe('committed installer config', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'assistant-installer', 'assistant.config.json'), 'utf8'));
  const rust = (f) => readFileSync(join(ROOT, 'src-tauri', 'src', 'commands', 'assistant', f), 'utf8');

  it('is approved and pinned by Plan 29-07: Gemma-3-1B-it on b12201, every sha256 present, the waiver recorded', () => {
    expect(config.status).toBe('approved');
    expect(() => assertMode(config, { release: true, allowCandidate: false })).not.toThrow();
    expect(config.runtime.tag).toBe('b12201');
    expect(config.runtime.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.model.file).toBe('gemma-3-1b-it-Q4_K_M.gguf');
    expect(config.model.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.model.license).toBe('Gemma Terms of Use');
    expect(config.approval.waiver.fixture).toBe('pair-price-es');
    expect(config.approval.ceilings.install_bytes_below).toBe(INSTALL_BUDGET_BYTES);
  });

  it('carries only server flags the Rust allow-list accepts', () => {
    const list = (name) => [...rust('sidecar.rs').match(new RegExp(`${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`))[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const values = list('VALUE_FLAGS');
    const switches = list('SWITCH_FLAGS');
    expect(values.length + switches.length).toBeGreaterThan(0);
    for (let i = 0; i < config.server_args.length; i++) {
      const flag = config.server_args[i];
      if (values.includes(flag)) i++;
      else expect(switches, `server_args entry ${flag}`).toContain(flag);
    }
  });

  it('uses the same strict budget as the Rust verifier', () => {
    expect(INSTALL_BUDGET_BYTES).toBe(1_000_000_000);
    expect(rust('manifest.rs')).toContain('INSTALL_BUDGET_BYTES: u64 = 1_000_000_000');
    expect(rust('manifest.rs')).toContain(`RUNTIME_EXE: &str = "${RUNTIME_EXE}"`);
  });

  it('fits the budget with the lead candidate artifacts', () => {
    expect(config.runtime.zip_bytes + config.model.bytes + UNINSTALLER_RESERVE_BYTES).toBeLessThan(INSTALL_BUDGET_BYTES);
  });
});

describe('installer.nsi Visual C++ runtime gate (option B: the POS installs it first)', () => {
  const nsi = readFileSync(join(ROOT, 'assistant-installer', 'installer.nsi'), 'utf8');

  it('checks the VC++ 14 x64 runtime in .onInit, before any section, and aborts non-zero with a message', () => {
    const onInit = nsi.slice(nsi.indexOf('Function .onInit'), nsi.indexOf('FunctionEnd', nsi.indexOf('Function .onInit')));
    expect(nsi.indexOf('Function .onInit')).toBeLessThan(nsi.indexOf('Section "Install"'));
    expect(nsi).toContain(String.raw`SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`);
    expect(onInit).toContain('SetRegView 64');
    expect(onInit).toContain('SetRegView 32');
    expect(onInit).toContain('"Installed"');
    expect(onInit).toMatch(/SetErrorLevel \$\{VCRT_EXIT_CODE\}\s+Abort/);
    expect(nsi).toMatch(/!define VCRT_EXIT_CODE [1-9]/);
    expect(nsi).toContain('Install the Supermarket POS first');
    expect(nsi).toContain('Instale primero Supermarket POS');
    expect(onInit).toContain('/SD IDOK');
  });

  const makensis = [process.env.TAURI_NSIS_DIR, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'tauri', 'NSIS')]
    .filter(Boolean)
    .map((d) => join(d, 'makensis.exe'))
    .find((p) => existsSync(p));

  it.skipIf(!makensis)('compiles with makensis (compile only: the installer is never run on the dev PC)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asst-nsi-'));
    try {
      mkdirSync(join(dir, 'stage'));
      writeFileSync(join(dir, 'stage', 'a.txt'), 'x');
      execFileSync(makensis, ['-V1', `-DSTAGE_DIR=${join(dir, 'stage')}`, `-DOUT_FILE=${join(dir, 'out.exe')}`, '-DVERSION=0.0.1', join(ROOT, 'assistant-installer', 'installer.nsi')], { stdio: 'pipe' });
      expect(existsSync(join(dir, 'out.exe'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

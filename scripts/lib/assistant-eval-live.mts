/**
 * Live candidate mode of scripts/assistant-eval.mts (Plan 29-07). A plain user-mode run: it stages a throwaway-signed
 * install dir with the real build script, starts the Rust probe (the same verify + spawn + Job path the POS uses) under a
 * CPU affinity mask, sends every fixture to the loopback server and measures size, cold start, latency, memory, CPU and a
 * responsiveness proxy. Every child is stopped by the PID this run started, never by image name.
 * The "low-end" profile is EMULATED on the dev PC (affinity 0xF, threads_max 2); it is not the till hardware.
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions -- numeric interpolation in log lines */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildMessages, screenInput } from '@shared/lib/local-assistant/prompt';
import { parseProposal, proposalJsonSchema } from '@shared/lib/local-assistant/proposal';
import type { Fixture, Result } from '../assistant-eval.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROFILES = { 'low-end': { mask: 'F', threadsMax: 2 }, standard: { mask: 'FF', threadsMax: 4 } } as const;
export type LiveArgs = { sidecar: string; model: string; profile: keyof typeof PROFILES; label: string; workDir?: string; responseFormat?: 'native' | 'openai' };

const ProbeLine = z.object({ ok: z.boolean(), reason: z.string().nullish(), probePid: z.number().optional(), childPid: z.number().optional(), port: z.number().optional(), readyMs: z.number().optional(), key: z.string().optional(), jobLimits: z.unknown().optional() });
const Completion = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1) });

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] ?? null);
const dirBytes = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirBytes(join(d, e.name)) : statSync(join(d, e.name)).size), 0);

function ps(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
/** Working set and CPU time of one PID (never by name); null when the process is gone. */
function sample(pid: number) {
  try {
    const out = ps(`$p = Get-Process -Id ${pid} -ErrorAction Stop; @{ws=$p.WorkingSet64; peakWs=$p.PeakWorkingSet64; private=$p.PrivateMemorySize64; cpu=$p.TotalProcessorTime.TotalSeconds} | ConvertTo-Json -Compress`);
    return z.object({ ws: z.number(), peakWs: z.number(), private: z.number(), cpu: z.number() }).parse(JSON.parse(out));
  } catch {
    return null;
  }
}
const alive = (pid: number) => sample(pid) !== null;
function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** Starts `exe args` under a CPU affinity mask the child tree inherits (cmd start /affinity). */
function startPinned(mask: string, exe: string, args: string[]): ChildProcess {
  return spawn('cmd.exe', ['/c', 'start', '""', '/b', '/wait', '/affinity', mask, exe, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function lines(child: ChildProcess, onLine: (l: string) => void) {
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
}

const TICKER = `let last = performance.now(); let buf = [];
setInterval(() => { const n = performance.now(); buf.push(Math.round((n - last - 10) * 100) / 100); last = n; }, 10);
setInterval(() => { console.log(JSON.stringify({ t: Date.now(), lags: buf })); buf = []; }, 1000);
`;

export async function runLive(args: LiveArgs, fixtures: Fixture[], evalFn: (f: Fixture, raw: string) => Result) {
  const prof = PROFILES[args.profile];
  const work = resolve(args.workDir ?? join(tmpdir(), 'assistant-eval'), `${args.label}-${args.profile}-${Date.now()}`);
  const probeExe = join(ROOT, 'src-tauri', 'target', 'debug', 'examples', 'assistant_probe.exe');
  if (!existsSync(probeExe)) throw new Error(`probe not built: ${probeExe} (cargo build --example assistant_probe in src-tauri)`);
  const artifacts = dirname(resolve(args.model));
  if (dirname(resolve(args.sidecar)) !== artifacts) throw new Error('--sidecar zip and --model must sit in the same artifacts folder');
  mkdirSync(work, { recursive: true });
  const started: (number | undefined)[] = [];
  const cmds: ChildProcess[] = [];
  const metrics: Record<string, unknown> = { profile: args.profile, profileEmulated: true, affinityMask: prof.mask, threadsMax: prof.threadsMax, label: args.label, model: basename(args.model), runtime: basename(args.sidecar) };
  const results: Result[] = [];
  try {
    // 1. throwaway signing key and a candidate install dir built by the real build script (never the committed config)
    const key = join(work, 'keys', 'eval.key');
    mkdirSync(dirname(key), { recursive: true });
    const password = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    execFileSync('node', [join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'generate', '--ci', '-p', password, '-w', key], { stdio: 'ignore' });
    const cfg = JSON.parse(readFileSync(join(ROOT, 'assistant-installer', 'assistant.config.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    Object.assign(cfg['runtime'] ?? {}, { zip: basename(args.sidecar), zip_bytes: statSync(args.sidecar).size, sha256: null });
    Object.assign(cfg['model'] ?? {}, { id: args.label, file: basename(args.model), bytes: statSync(args.model).size, sha256: null });
    Object.assign(cfg['profile'] ?? {}, { threads_max: prof.threadsMax });
    const cfgPath = join(work, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const out = join(work, 'out');
    execFileSync('node', [join(ROOT, 'scripts', 'assistant-build-installer.mjs'), '--artifacts', artifacts, '--out', out, '--allow-candidate', '--no-nsis', '--config', cfgPath], {
      stdio: 'ignore',
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
    });
    const stage = join(out, 'stage');
    copyFileSync(`${key}.pub`, join(work, 'test-pubkey.txt'));
    metrics['installBytes'] = dirBytes(stage);
    const request = (cfg['request'] ?? {}) as { max_tokens?: number; timeout_ms?: number; extra?: Record<string, unknown> };
    const timeoutMs = request.timeout_ms ?? 8000;

    // 2. start the probe pinned to the profile's CPUs and read port + test key + readyMs from its JSON line
    const probe = startPinned(prof.mask, probeExe, ['--install-dir', stage, '--pubkey-file', join(work, 'test-pubkey.txt'), '--test-print-key', '--hold-seconds', '3600']);
    cmds.push(probe);
    started.push(probe.pid);
    const first = await new Promise<z.infer<typeof ProbeLine> | null>(done => {
      const t = setTimeout(() => { done(null); }, 180_000);
      lines(probe, l => {
        const parsed = l.startsWith('{') ? ProbeLine.safeParse(JSON.parse(l)) : null;
        if (parsed?.success) {
          clearTimeout(t);
          done(parsed.data);
        }
      });
      probe.on('exit', () => { done(null); });
    });
    started.push(first?.probePid, first?.childPid);
    if (!first?.ok || first.port === undefined || first.key === undefined || first.childPid === undefined) {
      metrics['loadFailure'] = first ? (first.reason ?? 'PROBE_NOT_OK') : 'NO_PROBE_OUTPUT_IN_180S';
      return { results, metrics };
    }
    const { port, key: apiKey, childPid } = first;
    metrics['readyMs'] = first.readyMs;
    metrics['jobLimits'] = first.jobLimits;

    // 3. responsiveness ticker pinned to the SAME CPUs as the assistant (it stands in for the POS UI thread)
    const tickerPath = join(work, 'ticker.mjs');
    writeFileSync(tickerPath, TICKER);
    const ticker = startPinned(prof.mask, 'node', [tickerPath]);
    cmds.push(ticker);
    started.push(ticker.pid);
    const lagSamples: { t: number; lags: number[] }[] = [];
    lines(ticker, l => {
      if (l.startsWith('{')) lagSamples.push(JSON.parse(l) as { t: number; lags: number[] });
    });

    // native = the flat form ({type, schema}) that b12201 does NOT enforce (measured); openai = the nested form bridge.rs must send
    const formats = { native: { type: 'json_schema', schema: proposalJsonSchema }, openai: { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema: proposalJsonSchema } } };
    const chosen = args.responseFormat ?? 'openai';
    metrics['responseFormatUsed'] = chosen;
    const call = async (messages: unknown, shape: keyof typeof formats = chosen) => {
      const body = { ...request.extra, messages, temperature: 0, max_tokens: request.max_tokens ?? 160, stream: false, response_format: formats[shape] };
      const t0 = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        const ms = performance.now() - t0;
        if (!res.ok) return { ms, raw: '', status: res.status, timedOut: false };
        const parsed = Completion.safeParse(await res.json());
        return { ms, raw: parsed.success ? (parsed.data.choices[0]?.message.content ?? '') : '', status: res.status, timedOut: false };
      } catch (e) {
        return { ms: performance.now() - t0, raw: '', status: 0, timedOut: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') };
      }
    };

    await sleep(2000);
    const idleFrom = Date.now();
    await sleep(6000);
    const idleTo = Date.now();
    // the first request after start pays the shared prompt prefix; it is reported but excluded from the warm numbers
    const firstRequest = await call(buildMessages('price of ghee'));
    metrics['firstRequestMs'] = Math.round(firstRequest.ms);
    metrics['firstRequestTimedOut'] = firstRequest.timedOut;
    // does llama-server honour the Rust request shape ({type:json_schema, schema})? free text must still come back as a proposal
    const poem = [{ role: 'user', content: 'Write a short poem about cats in three lines.' }];
    const nativeCheck = await call(poem, 'native');
    const openaiCheck = await call(poem, 'openai');
    metrics['responseFormatHonoured'] = { native: parseProposal(nativeCheck.raw) !== null, openai: parseProposal(openaiCheck.raw) !== null };
    metrics['responseFormatSample'] = { native: nativeCheck.raw.slice(0, 80), openai: openaiCheck.raw.slice(0, 80) };

    const before = sample(childPid);
    const busyFrom = Date.now();
    const latencies: number[] = [];
    let timeouts = 0;
    for (const f of fixtures) {
      let raw = '';
      let ms: number | undefined;
      if (screenInput(f.text).ok) {
        const r = await call(buildMessages(f.text));
        raw = r.raw;
        ms = Math.round(r.ms);
        latencies.push(r.ms);
        if (r.timedOut) timeouts++;
      }
      const res = evalFn(f, raw);
      results.push({ ...res, ...(ms !== undefined ? { ms } : {}), raw: raw.slice(0, 300) });
    }
    const busyTo = Date.now();
    const after = sample(childPid);
    await sleep(1200);

    const lagIn = (a: number, b: number) => lagSamples.filter(s => s.t >= a && s.t <= b).flatMap(s => s.lags);
    const idleLag = pct(lagIn(idleFrom, idleTo), 95);
    const busyLag = pct(lagIn(busyFrom, busyTo + 1000), 95);
    const wallS = (busyTo - busyFrom) / 1000;
    Object.assign(metrics, {
      modelCalls: latencies.length,
      timeouts,
      timeoutRate: latencies.length ? timeouts / latencies.length : null,
      latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
      peakWorkingSetBytes: after?.peakWs ?? null,
      privateBytesEnd: after?.private ?? null,
      cpuSecondsBusy: before && after ? Math.round((after.cpu - before.cpu) * 100) / 100 : null,
      avgCoresBusy: before && after && wallS > 0 ? Math.round(((after.cpu - before.cpu) / wallS) * 100) / 100 : null,
      lagMs: { idleP95: idleLag, busyP95: busyLag, regressionPct: idleLag && busyLag ? Math.round(((busyLag - idleLag) / idleLag) * 1000) / 10 : null },
    });
    const lat = metrics['latencyMs'] as { p95: number | null };
    const lag = metrics['lagMs'] as { idleP95: number | null; busyP95: number | null };
    metrics['ceilings'] = {
      rssLe1200MB: (after?.peakWs ?? Infinity) <= 1.2e9,
      p95Le8s: (lat.p95 ?? Infinity) <= timeoutMs,
      coldStartLe30s: (first.readyMs ?? Infinity) <= 30_000,
      timeoutsLe5pct: latencies.length > 0 && timeouts / latencies.length <= 0.05,
      lagRegressionLe10pct: lag.idleP95 !== null && lag.busyP95 !== null ? lag.busyP95 <= lag.idleP95 * 1.1 : null,
      installUnder1e9: (metrics['installBytes'] as number) < 1_000_000_000,
    };
    return { results, metrics };
  } finally {
    for (const p of started) killTree(p);
    for (const c of cmds) killTree(c.pid);
    await sleep(1500);
    metrics['leftoverPids'] = started.filter((p): p is number => p !== undefined && alive(p));
    rmSync(work, { recursive: true, force: true });
  }
}

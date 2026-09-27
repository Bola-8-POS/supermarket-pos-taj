// Asserts (and, with --apply, enforces) the hosted Auth policy
// (scripts/lib/hosted-auth-policy.mjs) against a Supabase Management API
// project via `GET`/`PATCH /v1/projects/<ref>/config/auth`. Dependency-free
// (node: built-ins + the global fetch on Node 22); every I/O boundary is
// injectable through `deps` so the unit test never makes a network call.
//
// Usage: node scripts/check-hosted-auth.mjs --project-ref <ref> [--apply] [--json]
//
// Exit codes: 0 compliant (or compliant after --apply); 1 non-compliant;
// 2 usage/precondition error (no token, or --apply on an unlisted ref);
// 3 the Management API call itself failed (non-2xx after retry).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateHostedAuth, printableConfig } from './lib/hosted-auth-policy.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(repoRoot, 'customers', 'customers.json');

function defaultReadManifest() {
  return JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgv(argv) {
  const opts = { projectRef: null, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-ref') {
      opts.projectRef = argv[++i] ?? null;
    } else if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

function failureMessage(status, json) {
  const message = json && typeof json.message === 'string' ? json.message : '(no message field in response body)';
  return `status ${status}: ${message}`;
}

async function requestAuthConfig({ fetch, sleep }, projectRef, token, method, body) {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  let res = await fetch(url, init);
  if (res.status === 429) {
    const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
    const retryAfterSeconds = retryAfterHeader === null ? null : Number(retryAfterHeader);
    const waitMs =
      retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) ? Math.min(retryAfterSeconds, 60) * 1000 : 10_000;
    await sleep(waitMs);
    res = await fetch(url, init);
  }

  const text = typeof res.text === 'function' ? await res.text() : '';
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

function printMismatches(log, mismatches, config) {
  for (const { field, expected, actual } of mismatches) {
    log(`${field} ${JSON.stringify(expected)} ${JSON.stringify(actual)}`);
  }
  log(JSON.stringify(printableConfig(config)));
}

/**
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, env?: Record<string, string | undefined>, log?: (...a: unknown[]) => void, error?: (...a: unknown[]) => void, sleep?: (ms: number) => Promise<void>, readManifest?: () => unknown }} deps
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const sleep = deps.sleep ?? defaultSleep;
  const readManifest = deps.readManifest ?? defaultReadManifest;

  const { projectRef, apply, json } = parseArgv(argv);

  if (!projectRef) {
    error('Usage: node scripts/check-hosted-auth.mjs --project-ref <ref> [--apply] [--json]');
    return 2;
  }

  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    error('SUPABASE_ACCESS_TOKEN is not set. Set it to a Supabase personal access token and retry.');
    return 2;
  }

  if (apply) {
    let manifest;
    try {
      manifest = readManifest();
    } catch (err) {
      error(`--apply refuses: could not read customers/customers.json (${err.message})`);
      return 2;
    }
    const known = Array.isArray(manifest) && manifest.some((entry) => entry?.supabase_project_ref === projectRef);
    if (!known) {
      error(`--apply refuses --project-ref ${projectRef}: not found as a supabase_project_ref in customers/customers.json`);
      return 2;
    }
  }

  const deps2 = { fetch: fetchFn, sleep };

  const getResult = await requestAuthConfig(deps2, projectRef, token, 'GET');
  if (getResult.status < 200 || getResult.status >= 300) {
    error(`GET config/auth failed: ${failureMessage(getResult.status, getResult.json)}`);
    return 3;
  }

  const config = getResult.json ?? {};
  const evaluation = evaluateHostedAuth(config);

  if (!apply) {
    if (evaluation.ok) {
      log('hosted Auth policy: ok');
      if (json) log(JSON.stringify({ ok: true, mismatches: [], info: printableConfig(config) }));
      return 0;
    }
    printMismatches(log, evaluation.mismatches, config);
    if (json) log(JSON.stringify({ ok: false, mismatches: evaluation.mismatches, info: printableConfig(config) }));
    return 1;
  }

  if (Object.keys(evaluation.patch).length > 0) {
    const patchResult = await requestAuthConfig(deps2, projectRef, token, 'PATCH', evaluation.patch);
    if (patchResult.status < 200 || patchResult.status >= 300) {
      error(`PATCH config/auth failed: ${failureMessage(patchResult.status, patchResult.json)}`);
      return 3;
    }
  }

  const reGetResult = await requestAuthConfig(deps2, projectRef, token, 'GET');
  if (reGetResult.status < 200 || reGetResult.status >= 300) {
    error(`GET config/auth (re-check after --apply) failed: ${failureMessage(reGetResult.status, reGetResult.json)}`);
    return 3;
  }
  const secondConfig = reGetResult.json ?? {};
  const secondEvaluation = evaluateHostedAuth(secondConfig);

  if (secondEvaluation.ok) {
    log('hosted Auth policy: applied and ok');
    if (json) log(JSON.stringify({ ok: true, mismatches: [], info: printableConfig(secondConfig) }));
    return 0;
  }
  printMismatches(log, secondEvaluation.mismatches, secondConfig);
  error('hosted Auth policy: still non-compliant after --apply');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}

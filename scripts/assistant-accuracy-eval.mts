/**
 * Accuracy eval for the local assistant against a RUNNING llama-server (this script starts nothing).
 *
 *   npx tsx scripts/assistant-accuracy-eval.mts --url http://127.0.0.1:PORT [--fixtures f.json] [--out results.json]
 *   npx tsx scripts/assistant-accuracy-eval.mts --router-only [--fixtures f.json]   (no model: unrouted items count as model misses)
 *
 * Each phrasing goes through the app's real pipeline: screenInput -> route (deterministic pre-router; null falls
 * through to the model) -> buildMessages -> request body exactly as
 * bridge.rs::build_request_body builds it (manifest `extra` first, then messages, temperature 0, max_tokens,
 * stream false, response_format; serde_json preserve_order keeps this key order) -> parseProposal -> decide
 * (grounding guard + registry, manager rights). Scores:
 *  - intent accuracy: the final decision kind (or any refusal) equals the expected kind;
 *  - arg accuracy: the expected arguments are a subset of the final decision's;
 *  - invented args: arguments whose value is not in the user's message, counted on the raw proposal (before the
 *    guard) and on the final decision (after the guard; the target is 0). Judged by a simple substring check that
 *    shares no code with the guard.
 * Exit 0 when intent >= 90% and invented-after = 0, else 1.
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions -- CLI output interpolates counts */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '@features/assistant/model/tool-registry';
import { buildMessages, screenInput } from '@shared/lib/local-assistant/prompt';
import { parseProposal, proposalJsonSchema } from '@shared/lib/local-assistant/proposal';
import { route } from '@shared/lib/local-assistant/router';
import { STAFF_ACTIONS } from '@shared/lib/rbac';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const url = opt('url');
const routerOnly = argv.includes('--router-only');
if (!url && !routerOnly) {
  console.error('usage: assistant-accuracy-eval.mts (--url http://127.0.0.1:PORT | --router-only) [--fixtures f.json] [--out r.json]');
  process.exit(2);
}

type Case = { id: string; lang: 'en' | 'es'; text: string; kind: string; args?: Record<string, unknown> };
const cases = (
  JSON.parse(readFileSync(opt('fixtures') ?? join(ROOT, 'scripts/fixtures/assistant-accuracy.json'), 'utf8')) as { cases: Case[] }
).cases;
const config = JSON.parse(readFileSync(join(ROOT, 'assistant-installer/assistant.config.json'), 'utf8')) as {
  request: { max_tokens: number; extra: Record<string, unknown> };
};

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The request body in bridge.rs key order. */
function body(text: string): string {
  return JSON.stringify({
    ...config.request.extra,
    messages: buildMessages(text),
    temperature: 0,
    max_tokens: Math.min(config.request.max_tokens, 160),
    stream: false,
    response_format: { type: 'json_schema', json_schema: { name: 'proposal', strict: true, schema: proposalJsonSchema } },
  });
}

async function infer(text: string): Promise<string | null> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer eval' },
    body: body(text),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? null;
}

/** Free-text and number leaves of an args object; nulls and enum words (reason, sort) are not free values. */
function leaves(v: unknown, key = ''): { key: string; value: string | number }[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' || typeof v === 'number') return key === 'reason' || key === 'sort' ? [] : [{ key, value: v }];
  if (Array.isArray(v)) return v.flatMap(x => leaves(x, key));
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, k));
}

const DAY_VALUES = [0, 1, 7, 30]; // today, tomorrow, week, month: a time word in the message stands for these
// Number words, written out here on purpose (no code shared with the guard or the router).
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30,
};

/** Independent of the guard: each word's first 4 letters must be in the message; a number must be typed. */
function invented(args: unknown, text: string): number {
  const msg = fold(text);
  const nums = [
    ...(msg.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => parseFloat(n.replace(',', '.'))),
    ...(msg.match(/[a-z]+/g) ?? []).flatMap(w => WORD_NUMBERS[w] ?? []),
  ];
  return leaves(args).filter(({ key, value }) => {
    if (typeof value === 'number') {
      const n = key === 'priceCents' ? value / 100 : Math.abs(value);
      return !nums.includes(n) && !(key === 'withinDays' && DAY_VALUES.includes(value));
    }
    const ws = fold(value).match(/[\p{L}\p{N}]+/gu) ?? [];
    return ws.some(w => !msg.includes(w.slice(0, Math.min(4, w.length))));
  }).length;
}

function subset(want: unknown, got: unknown): boolean {
  if (want === null) return got === null || got === undefined;
  if (typeof want === 'string') return typeof got === 'string' && fold(got).includes(fold(want));
  if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w, i) => subset(w, got[i]));
  if (typeof want === 'object') {
    return Object.entries(want as Record<string, unknown>).every(([k, w]) =>
      subset(w, (got as Record<string, unknown> | undefined)?.[k])
    );
  }
  return want === got;
}

const can = new Set<string>(STAFF_ACTIONS); // manager rights: the eval is about routing, RBAC has its own tests
type Row = {
  id: string;
  lang: string;
  text: string;
  expect: string;
  got: string;
  via: 'router' | 'model' | 'none';
  raw: string | null;
  intentOk: boolean;
  argsOk: boolean;
  inventedBefore: number;
  inventedAfter: number;
};
const rows: Row[] = [];

for (const c of cases) {
  const screened = screenInput(c.text);
  let raw: string | null = null;
  let got = 'refuse';
  let args: unknown;
  let rawArgs: unknown;
  let via: Row['via'] = 'none';
  if (screened.ok) {
    const routed = route(screened.text);
    if (routed) {
      via = 'router';
      raw = JSON.stringify(routed);
    } else if (url) {
      via = 'model';
      raw = await infer(screened.text);
    }
    const proposal = raw === null ? null : parseProposal(raw);
    if (proposal) {
      rawArgs = 'args' in proposal ? proposal.args : undefined;
      const d = decide(proposal, a => can.has(a), screened.text);
      if (d.type !== 'refuse') {
        got = d.kind;
        args = d.args;
      }
    }
  }
  const row: Row = {
    id: c.id,
    lang: c.lang,
    text: c.text,
    expect: c.kind,
    got,
    via,
    raw,
    intentOk: got === c.kind,
    argsOk: got === c.kind && (c.args === undefined || subset(c.args, args)),
    inventedBefore: invented(rawArgs, c.text),
    inventedAfter: invented(args, c.text),
  };
  rows.push(row);
  console.log(
    `${row.intentOk ? 'ok  ' : 'FAIL'} ${row.id.padEnd(8)} want ${c.kind} got ${got}${row.argsOk ? '' : ' (args differ)'} [${via}] | ${raw ?? '-'}`
  );
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const slice = (lang?: string): Row[] => rows.filter(r => lang === undefined || r.lang === lang);
const line = (label: string, rs: Row[]): string =>
  `${label.padEnd(4)} n=${rs.length} intent ${pct(rs.filter(r => r.intentOk).length, rs.length)}  args ${pct(rs.filter(r => r.argsOk).length, rs.length)}  invented before-guard ${rs.reduce((n, r) => n + r.inventedBefore, 0)} after-guard ${rs.reduce((n, r) => n + r.inventedAfter, 0)}`;
console.log('\n' + [line('all', slice()), line('en', slice('en')), line('es', slice('es'))].join('\n'));
console.log(`routed by pre-router: ${rows.filter(r => r.via === 'router').length}/${rows.length}; routed but wrong: ${rows.filter(r => r.via === 'router' && !r.argsOk).length}`);
const outFile = opt('out');
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 2));
const intent = rows.filter(r => r.intentOk).length / rows.length;
process.exit(intent >= 0.9 && rows.every(r => r.inventedAfter === 0) ? 0 : 1);

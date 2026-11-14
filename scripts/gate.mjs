#!/usr/bin/env node
// npm run gate [step ...]  -- one table: typecheck, eslint (vs baseline), every lint:* script, unit tests.
// Steps run one at a time (low-memory machines). Exit 1 if any row is FAIL.
// LF is enforced by .gitattributes; this line changes the blob so a runner workspace that cached the CRLF copy re-checks it out.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Known eslint error count on this branch. Lower it as debt is cleared; more than this is a regression.
export const ESLINT_BASELINE = 0;

const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** First line that looks like a failure, else the first non-empty line. */
export function firstFailure(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /^(FAIL|×|✗|not ok)/i.test(l)) ?? lines.find((l) => /^error/i.test(l)) ?? lines.find((l) => /error|fail/i.test(l));
  return clip(hit ?? lines[0] ?? '(no output)');
}

/** eslint --format json -> { errors, first } */
export function parseEslint(stdout) {
  try {
    const files = JSON.parse(stdout);
    let errors = 0;
    let first = '';
    for (const f of files) {
      for (const m of f.messages) {
        if (m.severity !== 2) continue;
        errors += 1;
        first ||= `${f.filePath.replace(process.cwd(), '.')}:${m.line} ${m.ruleId ?? ''} ${m.message}`;
      }
    }
    return { errors, first };
  } catch {
    return { errors: NaN, first: firstFailure(stdout) };
  }
}

export function runStep(step) {
  const t0 = Date.now();
  const r = spawnSync(step.cmd, { shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (step.check) return { name: step.name, secs, ...step.check(r, out) };
  const ok = r.status === 0;
  return { name: step.name, secs, ok, detail: ok ? '' : firstFailure(out) };
}

export function renderTable(results) {
  const w = Math.max(...results.map((r) => r.name.length), 4);
  const rows = results.map((r) => `${r.name.padEnd(w)}  ${r.ok ? 'PASS' : 'FAIL'}  ${r.secs.padStart(6)}s  ${r.detail}`.trimEnd());
  const bad = results.filter((r) => !r.ok).length;
  return [`${'step'.padEnd(w)}  res   time    first failure`, ...rows, bad ? `GATE: FAIL (${bad})` : 'GATE: PASS'].join('\n');
}

export function buildSteps(pkgScripts) {
  const lintScripts = Object.keys(pkgScripts).filter((k) => k.startsWith('lint:') && k !== 'lint:fix');
  return [
    { name: 'typecheck', cmd: 'npx tsc --noEmit --pretty false' },
    {
      name: 'eslint',
      cmd: 'npx eslint src --max-warnings 0 --format json',
      check: (r) => {
        const { errors, first } = parseEslint(r.stdout ?? '');
        if (Number.isNaN(errors)) return { ok: false, detail: first };
        const ok = errors <= ESLINT_BASELINE;
        return { ok, detail: `${errors} errors (baseline ${ESLINT_BASELINE})${errors && first ? ` ${clip(first, 80)}` : ''}` };
      },
    },
    ...lintScripts.map((k) => ({ name: k, cmd: `npm run --silent ${k}` })),
    { name: 'vitest', cmd: 'npm run --silent test' },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const only = process.argv.slice(2);
  const steps = buildSteps(pkg.scripts).filter((s) => !only.length || only.includes(s.name));
  const results = steps.map((s) => {
    process.stderr.write(`gate: ${s.name}...\n`);
    return runStep(s);
  });
  console.log(renderTable(results));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

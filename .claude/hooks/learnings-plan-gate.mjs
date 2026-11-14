// PreToolUse (Write|Edit|MultiEdit) on plan files: the plan must carry a '## Lessons check' section
// citing at least one real L-id from .learnings/LOG.md, or the literal 'no lessons apply — <reason>'.
import { join } from 'node:path';
import { realDeps, readStdin } from './learnings-lib.mjs';

const EXEMPT = /LEDGER|HANDOFF|FINAL-REPORT|_followups/i;
const isPlan = (p) => {
  const f = String(p ?? '').replace(/\\/g, '/');
  if (!/\.md$/i.test(f) || EXEMPT.test(f.split('/').pop())) return false;
  return /(^|\/)docs\/superpowers\/plans\/.+\.md$/i.test(f) || /(^|\/)\.planning\/.*PLAN[^/]*\.md$/.test(f) || /-plan\.md$/i.test(f);
};

// Does `text` hold a passing Lessons-check section? knownIds = Set of L-ids present in LOG.md.
export function passes(text, knownIds) {
  const m = /^##\s+Lessons check\s*$([\s\S]*)/im.exec(text);
  if (!m) return 'missing a "## Lessons check" heading';
  const body = m[1].split(/^##\s/m)[0];
  if (/no lessons apply\s+[—-]\s+\S/i.test(body)) return null;
  const ids = body.match(/\bL\d+\b/g) ?? [];
  if (!ids.length) return 'the "## Lessons check" section cites no L-ids (or "no lessons apply — <reason>")';
  if (!ids.some((id) => knownIds.has(id))) return `none of ${[...new Set(ids)].join(', ')} exist in LOG.md`;
  return null;
}

// Returns deny reason or null. deps: { dir, read(path) }.
export function check(input, deps) {
  const ti = input?.tool_input ?? {};
  if (!/^(Write|Edit|MultiEdit)$/.test(String(input?.tool_name ?? '')) || !isPlan(ti.file_path)) return null;
  const log = deps.read(join(deps.dir, 'LOG.md')) ?? '';
  const known = new Set(log.match(/^- (L\d+)\b/gm)?.map((s) => s.slice(2)) ?? []);
  const fix = ` Fix: end the plan with "## Lessons check" (table: L-id | applies? | how this plan avoids it) citing ids from ${join(deps.dir, 'LOG.md')}, ` +
    'or write "no lessons apply — <reason>".';
  let why;
  if (input.tool_name === 'Write') why = passes(String(ti.content ?? ''), known);
  else {
    // Edit/MultiEdit grandfather old plans: deny only if the file passes today and the edit would break it.
    const onDisk = deps.read(String(ti.file_path));
    if (onDisk == null || passes(onDisk, known) !== null) return null;
    const edits = input.tool_name === 'Edit' ? [ti] : (ti.edits ?? []);
    let after = onDisk;
    for (const e of edits) {
      const o = String(e?.old_string ?? ''), n = String(e?.new_string ?? '');
      if (!o || !after.includes(o)) continue; // cannot place the edit: let the tool report it
      after = e.replace_all ? after.split(o).join(n) : after.replace(o, () => n);
    }
    why = passes(after, known);
  }
  return why ? `Plan file ${ti.file_path} refused: ${why}.${fix}` : null;
}

if (process.argv.includes('--selftest')) {
  const A = (await import('node:assert')).strict; let n = 0;
  const assert = Object.fromEntries(['equal', 'match', 'doesNotMatch', 'ok'].map((k) => [k, (...a) => { n++; A[k](...a); }]));
  const LOG = '# Log\n- L12 2026-10-01 [x] **A.** b\n- L30 2026-10-02 [y] **C.** d\n';
  let disk = {};
  const deps = { dir: '/m/.learnings', read: (p) => (p.endsWith('LOG.md') ? LOG : disk[p] ?? null) };
  const W = (file_path, content) => check({ tool_name: 'Write', tool_input: { file_path, content } }, deps);
  const P = 'docs/superpowers/plans/2026-11-02-x.md';
  const good = '# Plan\n## Lessons check\n| L-id | applies? | how |\n| L12 | yes | cap |\n';
  assert.equal(W(P, good), null);
  assert.equal(W(P, '# Plan\n## Lessons check\nno lessons apply — pure docs change\n'), null);
  assert.match(W(P, '# Plan\n- step'), /missing a/);
  assert.match(W(P, '# Plan\n## Lessons check\n| L999 | yes | x |'), /none of L999 exist/); // fake id
  assert.match(W(P, '# Plan\n## Lessons check\n\nTBD\n## Next\nL12'), /cites no L-ids/); // L12 outside the section
  assert.match(W(P, '# Plan\n## Lessons check\nno lessons apply\n'), /cites no L-ids/); // no reason given
  assert.match(W('.planning/phases/03/03-01-PLAN.md', '# p'), /refused/);
  assert.match(W('notes/api-plan.md', '# p'), /refused/);
  for (const f of ['docs/superpowers/plans/x-LEDGER.md', 'docs/superpowers/plans/HANDOFF.md', 'docs/superpowers/plans/FINAL-REPORT.md',
    'docs/superpowers/plans/_followups.md', 'docs/superpowers/specs/x.md', 'src/plan.ts', 'docs/planner.md', 'docs/superpowers/plans/x.txt'])
    assert.equal(W(f, '# nothing'), null, f);
  assert.equal(W('E:\\r\\docs\\superpowers\\plans\\x.md', '# p') === null, false); // windows separators still gated
  const E = (o, n, extra = {}) => check({ tool_name: 'Edit', tool_input: { file_path: P, old_string: o, new_string: n, ...extra } }, deps);
  assert.equal(E('x', 'tweak'), null); // not on disk: allow
  disk[P] = '# Plan only\n- step 2';
  assert.equal(E('step 2', 'step 3'), null); // old plan without section is grandfathered
  disk[P] = good;
  assert.equal(E('| L12 | yes | cap |', '| L12 | yes | cap2 |'), null); // keeps section
  assert.match(E('## Lessons check', '## Notes'), /refused/); // removes heading
  assert.match(E('L12', 'L999'), /none of L999 exist/); // breaks ids
  assert.equal(E('absent', 'x'), null); // cannot place edit
  assert.match(E('L', 'Q', { replace_all: true }), /refused/);
  const M = (edits) => check({ tool_name: 'MultiEdit', tool_input: { file_path: P, edits } }, deps);
  assert.equal(M([{ old_string: '# Plan', new_string: '# Plan 2' }]), null);
  assert.match(M([{ old_string: '# Plan', new_string: '# P' }, { old_string: '## Lessons check', new_string: '## X' }]), /refused/);
  assert.equal(check({ tool_name: 'Read', tool_input: { file_path: P } }, deps), null);
  console.log(`learnings-plan-gate selftest: ${n} checks passed`);
} else {
  readStdin((input) => {
    try {
      const reason = check(input, realDeps(input.cwd));
      if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    } catch (err) {
      process.stderr.write(`learnings-plan-gate: ${err?.message ?? err}\n`); // fail open, like the other hooks
    }
    process.exit(0);
  });
}

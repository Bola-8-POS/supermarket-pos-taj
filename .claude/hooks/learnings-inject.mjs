// Injects the shared lessons checklist: whole file into planning prompts (UserPromptSubmit),
// sections B+C and the capture rule into every subagent (SubagentStart). Missing files -> no output.
import { join } from 'node:path';
import { realDeps, readStdin } from './learnings-lib.mjs';

const PLANNING = /\b(write|draft|make|create|update|revise|re-?)\s*(a\s+|the\s+)?plan\b|\bplanning\b|\breplan\b|\broadmap\b|\bbrainstorm|design (doc|the)\b|\/gsd-(plan|discuss|spec|ultraplan|new-milestone)|writing-plans|brainstorming/i;
const MAX_LINES = 60;
const PLAN_RULE = "Run this plan against the checklist; the plan file must end with a '## Lessons check' table: L-id | applies? | how this plan avoids it.";

// Keep only the `## B.` / `## C.` sections.
function sections(md, letters) {
  const out = []; let keep = false;
  for (const line of md.split('\n')) {
    const h = /^##\s+([A-Z])\./.exec(line);
    if (h) keep = letters.includes(h[1]);
    if (keep) out.push(line);
  }
  return out.join('\n').trim();
}

// Returns additionalContext string or null. deps: { dir, read(path) }.
export function check(input, deps) {
  const checklist = deps.read(join(deps.dir, 'CHECKLIST.md'));
  if (!checklist) return null;
  const ev = input?.hook_event_name;
  if (ev === 'UserPromptSubmit') {
    if (!PLANNING.test(String(input.prompt ?? ''))) return null;
    return `LESSONS CHECKLIST (${join(deps.dir, 'CHECKLIST.md')})\n${checklist.trim()}\n\n${PLAN_RULE}`;
  }
  if (ev === 'SubagentStart') {
    const log = join(deps.dir, 'LOG.md');
    const tail = `\nFull checklist: ${join(deps.dir, 'CHECKLIST.md')}`;
    const rule = `Capture rule: before you stop, if you changed code or ran tests, append a lesson/gotcha/fallback to ${log} ` +
      `(APPEND with Bash '>>' or PowerShell Add-Content, never Write the whole file; duplicate L-numbers are fine: "- L<n> <YYYY-MM-DD> [area] **Title.** What happened -> rule. Fallback: ... Evidence: ..."), ` +
      `or end your reply with 'LESSONS: none — <reason>'. Otherwise you will be blocked from stopping.`;
    let body = sections(checklist, 'BC').split('\n');
    const cap = MAX_LINES - 4;
    if (body.length > cap) body = [...body.slice(0, cap), `... truncated, see ${join(deps.dir, 'CHECKLIST.md')}`];
    return `LESSONS CHECKLIST (sections B, C)\n${body.join('\n')}\n${tail}\n${rule}`;
  }
  return null;
}

if (process.argv.includes('--selftest')) {
  const A = (await import('node:assert')).strict; let n = 0;
  const assert = Object.fromEntries(['equal', 'match', 'doesNotMatch', 'ok'].map((k) => [k, (...a) => { n++; A[k](...a); }]));
  const md = '# T\n## A. Plan gate\n- [ ] **Alpha.** a (L1)\n## B. Task gate\n- [ ] **Beta.** b (L2)\n## C. During execution\n- [ ] **Gamma.** c (L3)\n## D. Sessions\n- [ ] **Delta.** d';
  const deps = { dir: '/m/.learnings', read: (p) => (p.endsWith('CHECKLIST.md') ? md : null) };
  const none = { dir: '/m/.learnings', read: () => null };
  const up = (prompt, d = deps) => check({ hook_event_name: 'UserPromptSubmit', prompt }, d);
  const sub = (d = deps) => check({ hook_event_name: 'SubagentStart' }, d);
  for (const p of ['write a plan for X', '/gsd-plan-phase 3', 'use writing-plans', 'brainstorm the roadmap', 'Re-plan the release', 'design doc please'])
    assert.match(up(p), /Alpha[\s\S]*Delta[\s\S]*Lessons check/, p);
  for (const p of ['run Plan 09 T6', 'the playwright spec failed', 'fix the login bug', 'explain planter boxes', 'airplane mode toggle', '/gsd-progress'])
    assert.equal(up(p), null, p);
  assert.equal(up('write a plan', none), null);
  const s = sub();
  assert.match(s, /Beta[\s\S]*Gamma/);
  assert.doesNotMatch(s, /Alpha|Delta/);
  assert.match(s, /LOG\.md/);
  assert.match(s, /LESSONS: none/);
  assert.match(s, /Add-Content/);
  assert.equal(sub(none), null);
  const big = { dir: 'd', read: () => '## B. x\n' + Array.from({ length: 100 }, (_, i) => `- [ ] r${i}`).join('\n') };
  assert.ok(sub(big).split('\n').length <= MAX_LINES + 2);
  assert.match(sub(big), /truncated/);
  assert.equal(check({ hook_event_name: 'Stop' }, deps), null);
  console.log(`learnings-inject selftest: ${n} checks passed`);
} else {
  readStdin((input) => {
    try {
      const ctx = check(input, realDeps(input.cwd));
      if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: ctx } }));
    } catch (err) { process.stderr.write(`learnings-inject: ${err?.message ?? err}\n`); }
    process.exit(0);
  });
}

// SubagentStop: a subagent that changed code or ran tests must record a lesson (or say none) before it stops.
// Fails open: any error allows the stop (never trap a subagent) and is written to stderr.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { realDeps, readStdin } from './learnings-lib.mjs';

const WORK_CMD = /git\s+commit|vitest|playwright|npm\s+run\s+(test|gate|lint)|cargo\s+test|deno\s+test/i;
const SCRATCH = /[\\/]scratchpad[\\/]|[\\/]\.learnings[\\/]/i;
const NONE = /LESSONS: none\s+[—-]\s+\S/;

// Walk the JSONL transcript: did the agent do work, record a lesson, and what was its last text?
export function scan(jsonl) {
  let worked = false, logged = false, last = '';
  for (const line of jsonl.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue;
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (text) last = text;
    for (const c of content.filter((x) => x.type === 'tool_use')) {
      const i = c.input ?? {};
      const fp = String(i.file_path ?? ''), cmd = String(i.command ?? '');
      if (/^(Edit|Write|MultiEdit)$/.test(c.name)) {
        if (/\.learnings[\\/]LOG\.md$/.test(fp)) logged = true;
        else if (!SCRATCH.test(fp)) worked = true; // scratchpad and lesson-store writes are not work
      } else if (/^(Bash|PowerShell)$/.test(c.name)) {
        if (/\.learnings/.test(cmd) && /LOG\.md/.test(cmd)) logged = true; // appended via >> / Add-Content
        if (WORK_CMD.test(cmd)) worked = true;
      }
    }
  }
  return { worked, logged, last };
}

// Returns a block reason string or null. deps: { dir, readTranscript(path) }.
export function check(input, deps) {
  if (input?.stop_hook_active) return null;
  // transcript_path is the MAIN session on SubagentStop; internal agents have an empty agent_type.
  const path = input?.agent_transcript_path;
  if (!path || !input?.agent_type) return null;
  const { worked, logged, last } = scan(deps.readTranscript(path) ?? '');
  const final = input.last_assistant_message || last;
  if (!worked || logged || NONE.test(final)) return null;
  const log = join(deps.dir, 'LOG.md');
  return `Before finishing: APPEND (Bash '>>' or PowerShell Add-Content; never Write the whole file, other agents append too) your lessons/gotchas/fallbacks to ${log} (next L-number, duplicates are fine; format: ` +
    `"- L<n> <YYYY-MM-DD> [area] **Title.** What happened -> rule. Fallback: ... Evidence: <commit/ledger/path>") ` +
    `and add/adjust a line in ${join(deps.dir, 'CHECKLIST.md')} if it generalises; ` +
    `or end your reply with 'LESSONS: none — <reason>'.`;
}

if (process.argv.includes('--selftest')) {
  const A = (await import('node:assert')).strict; let n = 0;
  const assert = Object.fromEntries(['equal', 'match', 'doesNotMatch', 'ok'].map((k) => [k, (...a) => { n++; A[k](...a); }]));
  const tu = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const tx = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const run = (lines, extra = {}) => check({ agent_transcript_path: 'x', agent_type: 'Sonnet', ...extra },
    { dir: '/main/.learnings', readTranscript: () => lines.join('\n') });
  const edit = tu('Edit', { file_path: 'src/a.ts' });
  assert.match(run([edit, tx('done')]), /main..learnings.LOG.md/);
  assert.match(run([tu('Bash', { command: 'npx vitest run a' }), tx('ok')]), /Before finishing/);
  assert.match(run([tu('PowerShell', { command: 'git commit -m x' }), tx('ok')]), /Before finishing/);
  assert.equal(run([tu('Read', { file_path: 'a' }), tu('Bash', { command: 'git status' }), tx('found it')]), null); // read-only
  assert.equal(run([edit, tx('done')], { stop_hook_active: true }), null);
  assert.equal(run([edit, tx('done\nLESSONS: none — trivial rename')]), null);
  assert.match(run([edit, tx('LESSONS: none')]), /Before finishing/); // near-miss: no reason given
  assert.equal(run([edit, tu('Write', { file_path: 'E:\\r\\.learnings\\LOG.md' }), tx('done')]), null);
  assert.match(run([edit, tu('Edit', { file_path: 'docs/LOG.md' }), tx('done')]), /Before finishing/); // wrong LOG.md
  assert.equal(check({}, { dir: 'd', readTranscript: () => '' }), null); // no transcript path
  const mainTx = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } });
  assert.equal(check({ transcript_path: 'x', agent_type: 'a' }, { dir: 'd', readTranscript: () => mainTx }), null); // main transcript never used
  assert.equal(run([edit, tx('done')], { agent_type: '' }), null); // internal agent
  assert.match(run([edit, tx('done')]), /Add-Content/);
  assert.equal(run([edit, tu('Bash', { command: 'echo "- L9 x" >> E:/r/.learnings/LOG.md' }), tx('done')]), null); // appended via shell
  assert.match(run([edit, tu('Bash', { command: 'echo hi >> notes/LOG.md' }), tx('done')]), /Before finishing/); // wrong LOG.md
  assert.equal(run([tu('Write', { file_path: 'E:\\c\\scratchpad\\t.js' }), tx('done')]), null); // scratchpad write
  assert.equal(run([tu('Write', { file_path: '/c/scratchpad/t.js' }), tu('Write', { file_path: 'E:\\r\\.learnings\\CHECKLIST.md' }), tx('done')]), null);
  assert.equal(run([edit, tx('x')], { last_assistant_message: 'LESSONS: none — docs only' }), null);
  console.log(`learnings-capture selftest: ${n} checks passed`);
} else {
  readStdin((input) => {
    try {
      const { dir } = realDeps(input.cwd);
      const reason = check(input, { dir, readTranscript: (p) => readFileSync(p, 'utf8') });
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch (err) { process.stderr.write(`learnings-capture: ${err?.message ?? err}\n`); }
    process.exit(0);
  });
}

// PreToolUse guard for the Agent tool: every implementer/reviewer subagent must be an
// agency-agents persona (see CLAUDE.md "Specialist Agent Routing"). Generic dispatches are refused.

const PERSONA_REASON =
  'Agent dispatch refused: subagent_type is {TYPE}. ' +
  'Implementation/spike/fix subagents must use the agency-agents persona from the CLAUDE.md ' +
  '"Specialist Agent Routing" table with model "sonnet"; reviewers use a persona with model "opus". ' +
  'Offline-first mapping: GoTrue/auth/RBAC -> Identity & Access Engineer; stack kit/gateway/edge functions/storage -> Backend Architect; ' +
  'migrations/backup/updater/cloud->local -> Database Reliability Engineer; Playwright/e2e -> Test Automation Engineer; ' +
  'Windows services/installer/Sandbox/Tauri -> Desktop App Engineer; gateway reliability -> SRE (Site Reliability Engineer); ' +
  'security-sensitive -> Application Security Engineer. Read-only lookups may use Explore, Plan, claude-code-guide, ' +
  'statusline-setup or codebase-memory*.';
const MODEL_MISSING = 'Set model explicitly: haiku for search/read/test runs, sonnet for code, opus only for review/planning.';
const OPUS_MISUSE = 'Opus is for review/planning only; use sonnet for code, haiku for lookups and test runs.';

// Returns a deny reason string, or null to allow. Pure, so --selftest can exercise it.
export function check(input) {
  const ti = input?.tool_input ?? {};
  const type = String(ti.subagent_type ?? '').trim();
  // Catch-all agents that would bypass persona routing. Everything else (personas, Explore, Plan,
  // claude-code-guide, statusline-setup, codebase-memory*) passes this check.
  if (new Set(['', 'general-purpose', 'claude', 'fork']).has(type.toLowerCase())) {
    return PERSONA_REASON.replace('{TYPE}', type ? `"${type}"` : 'missing');
  }
  const model = String(ti.model ?? '').trim().toLowerCase();
  if (!model) return MODEL_MISSING;
  if ((model === 'opus' || model === 'fable') && !/^(review|plan)/i.test(String(ti.description ?? '').trim())) {
    return OPUS_MISUSE;
  }
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

if (process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert');
  const t = (ti) => check({ tool_input: ti });
  const P = 'Backend Architect';
  assert.equal(t({ subagent_type: P, description: 'Fix bug' }), MODEL_MISSING);
  assert.equal(t({ subagent_type: P, model: '  ', description: 'Fix bug' }), MODEL_MISSING);
  assert.equal(t({ subagent_type: 'Explore', model: 'haiku', description: 'Find usages' }), null);
  assert.equal(t({ subagent_type: P, model: 'sonnet', description: 'Fix bug' }), null);
  assert.equal(t({ subagent_type: P, model: 'opus', description: 'Review diff' }), null);
  assert.equal(t({ subagent_type: P, model: 'opus', description: 'Plan phase 3' }), null);
  assert.equal(t({ subagent_type: P, model: 'opus', description: 'Fix bug' }), OPUS_MISUSE);
  assert.equal(t({ subagent_type: P, model: 'fable', description: 'Fix bug' }), OPUS_MISUSE);
  assert.match(t({ subagent_type: 'general-purpose', model: 'sonnet', description: 'x' }), /Agent dispatch refused/);
  assert.match(t({ model: 'sonnet' }), /missing/);
  console.log('require-persona-agent selftest: 10 checks passed');
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { /* unparseable: empty input is refused as missing persona */ }
    const reason = check(input);
    if (reason) deny(reason);
    process.exit(0);
  });
}

// Shared by the learnings-* hooks: locate the lesson store (main checkout, shared by all worktrees).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function storeDir(cwd) {
  const proj = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: cwd || proj, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) return join(dirname(common), '.learnings');
  } catch { /* not a git dir: fall back */ }
  return join(proj, '.learnings');
}

export const realDeps = (cwd) => ({
  dir: storeDir(cwd),
  read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
});

export function readStdin(run) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { /* handled by caller as empty input */ }
    run(input);
  });
}

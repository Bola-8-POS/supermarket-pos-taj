// PreToolUse guard (Bash|PowerShell|Read|Grep|Supabase MCP): commits in the main checkout, hook bypasses, kill by
// image name, self-hosted :54321, env-file reads, pushes and production Supabase writes (read-only SELECT on prod passes). Fails closed (ask) on error.
// check(input) returns { decision: 'deny' | 'ask', reason } or null. Pure, so --selftest can exercise it.
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAIN = 'e:/projects/code/supermarket-pos';
const COMMIT_REASON = 'Commit in a worktree on its own branch, never in the main checkout (E:/Projects/Code/supermarket-pos).';
const PROD = new Set(['xmjpnhowadqgewuxpqva', 'mkvinyekkyennyegfoxq', 'zhvcivnojpvgwiknlpuj', 'zylymybxvwnymcapwpch']);
const WRITES = /(apply_migration|deploy_edge_function|create_edge_function_secret|restore_project|pause_project|create_project|create_branch|delete_branch|merge_branch|reset_branch|rebase_branch)$/;
const SQL_WRITE = /\b(insert|update|delete|alter|drop|create|grant|revoke|truncate|vacuum|call|merge|copy|refresh|reindex)\b|\bcomment\s+on\b|\bdo\s*\$\$/i;
const SQL_OK = /^(count|sum|min|max|avg|now|coalesce|in|exists|any|all|over|values|and|or|not|as|from|where|on|join|using|filter|by|select|having|union|case|when|then|else|limit|offset|with|distinct|between|like|ilike|is|group|order|partition|cast)$/i;
const sqlRisky = (q) => SQL_WRITE.test(q) || (/\bselect\b/i.test(q) && [...q.matchAll(/(\w+)\s*\(/g)].some((m) => !SQL_OK.test(m[1])));
// Production allow-list (prod ids only; non-prod keeps the deny-list sqlRisky). Returns true ONLY for a provably read-only statement, else false (ask).
// Rule: comments/literals stripped (unterminated or E'..' strings -> false); exactly one statement; starts with select/with, `explain` without analyze, or `show`;
// no SQL_WRITE word, no into/set/reset/lock/notify/listen/execute/prepare/do/for update|share; every `name(` call must be a known pure builtin (SQL_OK or SAFE_FN).
// Schema-qualified or user functions (public.f(), auth.uid()) cannot be proven read-only, so they ask. Assumes standard_conforming_strings=on (Supabase default).
const SQL_BLOCK = /\b(into|set|reset|lock|notify|listen|unlisten|execute|prepare|deallocate|do)\b|\bfor\s+(no\s+key\s+)?(update|share)\b|\bkey\s+share\b/;
const SAFE_FN = /^(nullif|greatest|least|md5|length|char_length|lower|upper|trim|ltrim|rtrim|btrim|substr|substring|replace|concat|concat_ws|left|right|position|initcap|lpad|rpad|repeat|reverse|round|ceil|ceiling|floor|abs|mod|power|sqrt|sign|trunc|age|extract|date_part|date_trunc|make_date|row_number|rank|dense_rank|lag|lead|first_value|last_value|ntile|bool_and|bool_or|every|stddev|variance|unnest|generate_series|cardinality|row_to_json|split_part|translate|format|current_setting|current_database|current_user|version|pg_size_pretty|pg_table_size|pg_total_relation_size|pg_relation_size|pg_database_size|pg_get_\w+def|has_table_privilege|obj_description|array|row|lateral|materialized|numeric|decimal|varchar|char|character|timestamp|timestamptz|time|interval|bit|jsonb?_\w+|to_\w+|array_\w+|string_\w+|regexp_\w+)$/i;
function sqlClean(q) {
  let out = '', i = 0;
  while (i < q.length) {
    const c = q[i], d = q[i + 1];
    if (c === '-' && d === '-') { const e = q.indexOf('\n', i); if (e < 0) break; out += ' '; i = e + 1; continue; }
    if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < q.length && depth) { if (q.startsWith('/*', j)) { depth++; j += 2; } else if (q.startsWith('*/', j)) { depth--; j += 2; } else j++; }
      if (depth) return null;
      out += ' '; i = j; continue;
    }
    if (c === "'" || c === '"') {
      if (c === "'" && /(^|\W)e$/i.test(out)) return null; // E'..' has backslash escapes: not parsed here
      let j = i + 1;
      for (;;) { const k = q.indexOf(c, j); if (k < 0) return null; if (q[k + 1] === c) { j = k + 2; continue; } j = k + 1; break; }
      out += c === "'" ? "''" : '_id'; i = j; continue;
    }
    if (c === '$' && !/\w$/.test(out)) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(q.slice(i));
      if (m) { const k = q.indexOf(m[0], i + m[0].length); if (k < 0) return null; out += "''"; i = k + m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}
function sqlReadOnly(q) {
  const clean = sqlClean(q);
  if (clean === null) return false;
  let s = clean.trim().replace(/;\s*$/, '').trim().toLowerCase();
  if (!s || s.includes(';')) return false;
  if (/^show\s+[\w. ]+$/.test(s)) return true;
  const ex = /^explain\s*((\([^)]*\)|verbose)\s*)*/.exec(s);
  if (ex) { if (/analy[sz]e/.test(ex[0])) return false; s = s.slice(ex[0].length); }
  if (!/^(select|with)\b/.test(s) || SQL_WRITE.test(s) || SQL_BLOCK.test(s)) return false;
  return [...s.matchAll(/([\w$.]+)\s*\(/g)].every((m) => SQL_OK.test(m[1]) || SAFE_FN.test(m[1]));
}
const ENV_RE = /(?:^|[\s"'/\\<>*=(])\.env(\.[\w.*-]+)?(?=$|[\s"'|;&)<>*])/gi;
const ENV_REDIRECT = /\d?>>?\s*["']?[^\s"'|;&)<>]*\.env(\.[\w.-]+)?["']?/gi;
const ENV_COPY = /^(cp|mv|copy|move|robocopy|xcopy|copy-item|move-item)(\.exe)?$/i;
const envNamed = (s) => [...s.replace(ENV_REDIRECT, '').matchAll(ENV_RE)].some((m) => !/^\.example$/i.test(m[1] ?? ''));
const PORT_RE = /https?:\/\/[^\s'"]*:54321(?!\d)|(?:--port|-p)[\s=]+54321(?!\d)/;

const norm = (p) => p.replace(/\\/g, '/').replace(/^["']|["']$/g, '').replace(/^\/([a-z])\//i, '$1:/').toLowerCase().replace(/\/+$/, '');
const resolve = (dir, cwd) => (/^[a-z]:\//.test(norm(dir)) ? norm(dir) : posix.normalize(`${cwd}/${norm(dir)}`));
// ponytail: main checkout = the root or any subpath except .claude/worktrees; symlinks/junctions are not resolved.
const isMain = (p) => p === MAIN || (p.startsWith(`${MAIN}/`) && !p.includes('/.claude/worktrees/'));
const words = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const envTarget = (p) => { const f = norm(String(p ?? '')).split('/').pop(); return /^\.env(\..+|\*)?$/.test(f) && f !== '.env.example'; };
const deny = (reason) => ({ decision: 'deny', reason });
// Drop heredoc bodies, PowerShell here-strings and -m "msg" text so prose never trips a rule (unless it runs $(...)).
const strip = (c) => c
  .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$3')
  .replace(/@(['"])[ \t]*\n[\s\S]*?\n\1@/g, '""')
  .replace(/(\s-[a-zA-Z]*m|--message)([\s=]+)("(?:[^"\\]|\\.)*"|'[^']*')/g, (m, f, _s, q) => (/\$\(|`/.test(q) ? m : `${f} ""`));
const prep = (s) => s.trim().replace(/^&\s*/, '').replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');

function checkShell(raw, startCwd, tool) {
  const command = strip(raw);
  let cwd = norm(startCwd ?? '');
  let ask = null;
  if (PORT_RE.test(command)) return deny('Port 54321 is the self-hosted stack; local tests use dev2 on 56321.');
  for (const seg of command.split(/&&|\|\||[;\n|]|\s&(?=\s)/).map(prep).filter(Boolean)) {
    const w = words(seg), cmd = (w[0] ?? '').toLowerCase();
    const cd = /^(cd|set-location|sl|pushd)$/.test(cmd) ? w.slice(1).find((x) => !/^(\/d|-path|-literalpath)$/i.test(x)) : null;
    if (cd) { cwd = resolve(cd, cwd); continue; }
    const stopper = /^(stop-process|spps)$/.test(cmd) || (tool === 'PowerShell' && cmd === 'kill');
    if (/\btaskkill\b.*[/-]IM\b/i.test(seg) || /\bStop-Process\b.*-Name\b/i.test(seg) || /\b(pkill|killall)\b/.test(seg) || (stopper && !w.some((x) => /^-id$/i.test(x)))) {
      return deny('Never kill by image name; kill your own process tree by PID (taskkill /PID, Stop-Process -Id).');
    }
    if (!ENV_COPY.test(cmd) && envNamed(seg)) return deny('Do not read or print env files (secrets). Copy or move them instead.');
    if (!/(^|[\\/])git(\.exe)?$/i.test(w[0] ?? '')) continue;
    if (w.includes('--no-verify') || /core\.hookspath/i.test(seg)) return deny('Skipping git hooks (--no-verify, core.hooksPath) is forbidden; fix the hook failure instead.');
    let dir = cwd, i = 1;
    for (; i < w.length && w[i].startsWith('-'); i++) {
      if (w[i] === '-C') dir = resolve(w[++i] ?? '.', dir);
      else if (w[i] === '-c') i++;
    }
    const sub = w[i], rest = w.slice(i + 1), inMain = isMain(dir);
    if (sub === 'commit' && rest.some((x) => /^-[a-z]*n[a-z]*$/.test(x))) return deny('git commit -n skips hooks; run the hooks.');
    if (/^(commit|cherry-pick|revert|am|rebase)$/.test(sub) || (sub === 'reset' && rest.includes('--hard'))) { if (inMain) return deny(COMMIT_REASON); }
    if (sub === 'push') ask ??= { decision: 'ask', reason: 'git push: the owner says when.' };
    if (inMain && (/^(restore|clean|pull)$/.test(sub) || (sub === 'checkout' && rest.includes('--')) || (sub === 'stash' && /^(drop|clear)$/.test(rest[0] ?? '')))) {
      ask ??= { decision: 'ask', reason: `git ${sub} in the main checkout can destroy work or move it; confirm with the owner.` };
    }
  }
  return ask;
}

function run(input) {
  const tool = String(input?.tool_name ?? ''), ti = input?.tool_input ?? {};
  if (tool === 'Bash' || tool === 'PowerShell') return checkShell(String(ti.command ?? ''), input.cwd, tool);
  if (tool === 'Read') return envTarget(ti.file_path) ? deny('Do not read env files (secrets).') : null;
  if (tool === 'Grep') return envTarget(ti.path) || envTarget(ti.glob) ? deny('Do not search env files (secrets).') : null;
  if (/^mcp__claude_ai_Supabase__/.test(tool)) {
    const name = tool.split('__').pop();
    if (WRITES.test(tool) || (name === 'execute_sql' && (PROD.has(ti.project_id) ? !sqlReadOnly(String(ti.query ?? '')) : sqlRisky(String(ti.query ?? ''))))) {
      return { decision: 'ask', reason: `Supabase ${name} on project_id ${ti.project_id ?? 'unknown'}: production write needs the owner's go.` };
    }
  }
  return null;
}

export function check(input) {
  try { return run(input); } catch (e) { return { decision: 'ask', reason: `guardrails error, failing closed: ${e?.message ?? e}` }; }
}

const direct = Boolean(process.argv[1]) && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (direct && process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert');
  const { spawn } = await import('node:child_process');
  const MAINDIR = 'E:\\Projects\\Code\\supermarket-pos', WT = 'E:/Projects/Code/supermarket-pos-worktrees/guardrails';
  const tl = (tool_name, tool_input, cwd = WT) => check({ tool_name, cwd, tool_input })?.decision ?? null;
  const sh = (command, cwd, tool = 'Bash') => tl(tool, { command }, cwd);
  const ps = (c, cwd) => sh(c, cwd, 'PowerShell'), mc = (c) => sh(c, MAINDIR);
  const sb = (name, ti) => tl(`mcp__claude_ai_Supabase__${name}`, ti);
  const sql = (project_id, query) => sb('execute_sql', { project_id, query });
  const rd = (file_path) => tl('Read', { file_path }), gr = (ti) => tl('Grep', ti);
  const boom = check({ tool_name: 'Bash', tool_input: { command: { toString() { throw new Error('boom'); } } } });
  const hangs = await new Promise((done) => { // item 10: importing the module must not wait on stdin
    const c = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(import.meta.url)})`], { stdio: ['pipe', 'ignore', 'ignore'] });
    const t = setTimeout(() => { c.kill(); done(true); }, 3000);
    c.on('exit', () => { clearTimeout(t); done(false); });
  });
  const cases = [
    // commits in main, push, no-verify
    [mc('git commit -m x'), 'deny'], [sh('git commit -m x'), null], [sh('git -C E:/Projects/Code/supermarket-pos commit -m x'), 'deny'],
    [sh('cd /e/Projects/Code/supermarket-pos && git cherry-pick abc'), 'deny'], [ps('Set-Location E:\\projects\\code\\supermarket-pos; git reset --hard HEAD~1'), 'deny'],
    [mc('git reset --soft HEAD~1'), null], [sh('git commit -m x', MAINDIR + '\\.claude\\worktrees\\a'), null],
    [mc('git -C E:/Projects/Code/supermarket-pos-worktrees/x commit -m y'), null], [mc('git merge --ff-only b'), null],
    [mc('git status && git log && git diff && git worktree list && git fetch'), null], [sh('git push origin b'), 'ask'], [sh('git commit --no-verify -m x'), 'deny'],
    // 1 hook bypass flags
    [sh('git commit -n -m x'), 'deny'], [sh('git commit -an -m x'), 'deny'], [sh('git commit -nm x'), 'deny'], [sh('git -c core.hooksPath=/dev/null commit -m x'), 'deny'],
    [sh('git -c core.hookspath=x status'), 'deny'], [sh('git commit -m "use -n here"'), null],
    // 2 main-commit detection survives prefixes
    [mc('& git commit -m x'), 'deny'], [mc('HUSKY=0 git commit -m x'), 'deny'], [mc('git.exe commit -m x'), 'deny'], [mc('FOO=1 BAR="a b" git commit -m x'), 'deny'],
    [mc('"C:/Program Files/Git/bin/git.exe" commit -m x'), 'deny'], [ps('& git commit -m x', MAINDIR), 'deny'], [mc('sleep 1 & git commit -m x'), 'deny'],
    // 3 kill
    [sh('taskkill /IM chrome.exe /F'), 'deny'], [sh('taskkill /PID 123 /T'), null], [ps('Stop-Process -Name node'), 'deny'], [ps('Stop-Process -Id 5'), null],
    [ps('Get-Process node | Stop-Process'), 'deny'], [ps('kill 5'), 'deny'], [ps('kill -Id 5'), null], [sh('kill -9 123'), null], [sh('pkill node'), 'deny'], [sh('killall node'), 'deny'],
    // 4 env prints
    [sh('cat .env.local'), 'deny'], [ps('Get-Content .env'), 'deny'], [sh('grep KEY ./.env.production'), 'deny'], [sh('cat .env.example'), null],
    [sh('echo A > .env.local'), null], [sh('echo A >> .env'), null], [sh('cat .env > x'), 'deny'], [sh('cat .env >.env.bak'), 'deny'], [sh('type ".env"'), 'deny'],
    [sh('cat .env*'), 'deny'], [sh('cat <.env'), 'deny'], [sh('(cat .env)'), 'deny'], [ps('Get-Content .env.production | Out-Null'), 'deny'], [sh('git add .env'), 'deny'],
    [sh('node x --env-file=.env'), 'deny'], [ps('Copy-Item .env.local x'), null], [sh('cp .env.local ../x/.env.local'), null], [sh('mv .env a'), null],
    [sh('robocopy a b .env.local'), null], [ps('xcopy .env.local x'), null], [sh('cat src/environment.ts'), null],
    // 5 Read/Grep
    [rd('E:\\p\\.env.local'), 'deny'], [rd('E:\\p\\src\\env.ts'), null], [rd('E:\\p\\.env.example'), null],
    [gr({ pattern: 'k', path: 'E:\\p\\.env.local' }), 'deny'], [gr({ pattern: 'k', glob: '.env*' }), 'deny'], [gr({ pattern: 'k', glob: '**/.env.production' }), 'deny'],
    [gr({ pattern: 'k', path: 'E:\\p\\src' }), null], [gr({ pattern: 'k', glob: '.env.example' }), null],
    // 6 Supabase
    [sb('apply_migration', { project_id: 'p1' }), 'ask'], [sb('deploy_edge_function', { project_id: 'p1' }), 'ask'], [sb('pause_project', { project_id: 'p1' }), 'ask'], [sb('list_tables', { project_id: 'p1' }), null],
    // production ids: null only for provably read-only SQL (allow-list), everything else asks. Reading auth.users/profiles is allowed here:
    // hiding the pin column is a policy/RLS matter, not this guardrail's job.
    ...['xmjpnhowadqgewuxpqva', 'mkvinyekkyennyegfoxq', 'zhvcivnojpvgwiknlpuj', 'zylymybxvwnymcapwpch'].flatMap((p) => [[sql(p, 'select 1'), null], [sql(p, 'delete from t'), 'ask']]),
    ...[
      'select 1', 'select count(*) from public.profiles', 'select * from supabase_migrations.schema_migrations', 'select * from auth.users limit 5',
      '  \n\tSELECT Id, Max(x) FROM t;  ', 'Select 1 -- ; drop table t', "select 'a;b'", "select 'it''s; fine' as x", 'select $$a;b$$', '/* x */ select 1', 'select * from t; --',
      "with a as (select 1 x), b as (select x from a)\nselect jsonb_agg(b), string_agg(x::text, ','), to_char(now(), 'YYYY')\nfrom b\nwhere x in (select 1)",
      'explain select * from t', 'show search_path', 'select * from updates', 'select coalesce(a,b), md5(c), length(d), array_agg(e) from t group by 1', 'select x::numeric(10,2) from t',
    ].map((q) => [sql('xmjpnhowadqgewuxpqva', q), null]),
    ...[
      'delete from t', 'update t set a=1', 'insert into t values (1)', 'select 1; delete from t', 'select 1; select 2', 'with x as (delete from t returning *) select * from x',
      'with x as (update t set a=1 returning *) select * from x', 'select * into t2 from t', 'select * from t for update', 'select * from t for share', 'select pg_sleep(1)',
      "select set_config('a','b',false)", "select nextval('s')", "select setval('s',1)", 'explain analyze delete from t', 'explain (analyze) select 1', '/* x */ drop table t',
      'select 1 /* unterminated', "select 'unterminated", 'DELETE FROM t', '\n  Update t set a=1', 'select pg_terminate_backend(1)', "select lo_import('/x')", "select pg_read_file('/etc/passwd')",
      "select * from dblink('x','y')", 'select public.my_fn()', 'select auth.uid()', 'begin', 'set role postgres', 'select 1 -- c\n; drop table t', "select e'\\'; drop table t; --'", '',
      'select $a$ x $b$ ; drop table t', 'with x as (select 1) insert into t select * from x', "select 1 where 'a'='a'; truncate t",
    ].map((q) => [sql('xmjpnhowadqgewuxpqva', q), 'ask']),
    [sb('apply_migration', { project_id: 'mkvinyekkyennyegfoxq' }), 'ask'], [sb('deploy_edge_function', { project_id: 'mkvinyekkyennyegfoxq' }), 'ask'], [sb('pause_project', { project_id: 'xmjpnhowadqgewuxpqva' }), 'ask'],
    [sb('create_edge_function_secret', { project_id: 'xmjpnhowadqgewuxpqva' }), 'ask'], [sb('restore_project', { project_id: 'xmjpnhowadqgewuxpqva' }), 'ask'], [sb('list_tables', { project_id: 'xmjpnhowadqgewuxpqva' }), null],
    [sql('p1', 'select * from updates'), null], [sql('p1', 'DELETE from t'), 'ask'], [sql('p1', 'Comment  On table t is 1'), 'ask'],
    ...['call f()', 'merge into t using u on x', 'copy t to stdout', 'refresh materialized view v', 'reindex table t', 'do $$ begin end $$', 'select pg_sleep(1)'].map((q) => [sql('p1', q), 'ask']),
    [sql('p1', 'select count(*), max(x) from t'), null], [sql('p1', 'select coalesce(a,b), now() from t'), null], [sql('p1', 'select * from t where id in (select id from u)'), null],
    // 7 :54321
    [sh('curl http://127.0.0.1:54321/rest/v1'), 'deny'], [sh('supabase start --port 54321'), 'deny'], [sh('x -p 54321'), 'deny'], [sh('curl http://127.0.0.1:56321/rest/v1'), null],
    [sh('curl http://h:543210/x'), null], [sh('git commit -m "note about :54321"'), null],
    // 8 heredoc / message stripping
    [sh("git commit -F - <<'EOF'\nfix cat .env.local and pkill node\nEOF"), null], [sh('git commit -F - <<EOF\ncat .env\nEOF'), null],
    [ps("git commit -m @'\ncat .env.local\n'@"), null], [sh('git commit -m "pkill node"'), null], [sh("git commit -m 'cat .env'"), null],
    [sh('cat <<EOF\nx\nEOF\ncat .env'), 'deny'], [mc("git commit -F - <<'EOF'\nmsg\nEOF"), 'deny'], [sh('git commit -m "$(cat .env)"'), 'deny'],
    // 9 fail closed, 10 import safety
    [boom?.decision, 'ask'], [/boom/.test(boom?.reason ?? ''), true], [hangs, false],
    // 11 destructive git in main only
    [mc('git checkout -- src/a.ts'), 'ask'], [mc('git restore src/a.ts'), 'ask'], [mc('git clean -fd'), 'ask'], [mc('git pull'), 'ask'], [mc('git stash drop'), 'ask'], [mc('git stash clear'), 'ask'],
    [mc('git stash'), null], [mc('git checkout main'), null], [sh('git pull'), null], [sh('git clean -fd'), null], [sh('git restore x'), null],
  ];
  const bad = cases.flatMap(([got, want], n) => (got === want ? [] : [`case ${n}: got ${got}, want ${want}`]));
  assert.deepEqual(bad, []);
  assert.match(check({ tool_name: 'mcp__claude_ai_Supabase__apply_migration', tool_input: { project_id: 'abc' } }).reason, /abc.*production write needs the owner's go/);
  console.log(`guardrails selftest: ${cases.length + 1} checks passed`);
} else if (direct) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let r;
    try { r = check(JSON.parse(raw)); } catch (e) { r = { decision: 'ask', reason: `guardrails: unreadable hook input (${e.message})` }; }
    if (r) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason },
      }));
    }
    process.exit(0);
  });
}

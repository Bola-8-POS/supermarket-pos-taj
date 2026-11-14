// Secret-shaped literal rules, ported from the portal's scripts/lib/secrets.mjs
// (same ids where the pattern is the same), plus this repo's own scoping and two
// added rules (pin-context, connection-string, supabase-legacy-url).
//
// No `g` flag on any rule: `.test()` must stay stateless across lines.

export const IGNORE_MARKER = 'secret-scan-ignore';

export const RULES = [
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'private-key-header', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { id: 'supabase-key', re: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'pin-literal', re: /\bPINs?\b\s*(?:(?:is|was|=|:|-|–|—)\s*)?['"`]?\d{4,6}\b/ },
  { id: 'pin-assignment', re: /\bpin\b\s*[:=]\s*['"`]?\d{4,6}\b/i },
  // Env-style PIN names (E2E_ADMIN_PIN=...): pin-assignment's \bpin\b never
  // matches here because the character before "PIN" is `_` (a word
  // character, so no boundary). Case-sensitive by design; all files.
  { id: 'pin-env-assignment', re: /\b[A-Z0-9_]*PIN\b\s*[:=]\s*['"`]?\d{4,8}\b/ },
  {
    id: 'credential-assignment',
    re: /\b(?:service_role|SERVICE_ROLE_KEY|api[_-]?key|secret|password)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    // supabase/config.toml's `secret = "env(SOME_VAR)"` lines are a variable
    // reference, not a value: never flag them.
    skip: (line) => /[:=]\s*['"]?env\(/i.test(line),
  },
  // Dev/demo PINs are runs of one digit; scoped to docs and the two known dev-data
  // paths (product code/tests carry their own allow-list entries, not a rule scope).
  {
    id: 'repeated-digits',
    // Bounded by non-word/non-hyphen on both sides so a run inside a
    // hyphen-delimited UUID or SKU segment (e.g. ...-1111-...) never matches.
    re: /(?<![\w-])(\d)\1{3,5}(?![\w-])/,
    scope: (path) => /\.md$/i.test(path) || path === 'supabase/seed.sql' || /^scripts\/seed-[^/]+\.ts$/.test(path),
  },
  // Regression guard for the outage-note class of document: "pin" within 80 chars
  // of a 6-digit run, docs only (code has pin-assignment/pin-literal already).
  {
    id: 'pin-context',
    re: /\bpins?\b[^\n]{0,80}\b\d{6}\b/i,
    scope: (path) => /\.md$/i.test(path),
  },
  // A real password in a postgres(ql):// URI. The negative lookaheads let the
  // local dev default (postgres:postgres@) and <PLACEHOLDER>-style values pass.
  {
    id: 'connection-string',
    re: /postgres(ql)?:\/\/[^\s:\/]+:(?!postgres@)(?![<$\[{])[^@\s]+@/,
  },
  // A hard-coded project host, code paths only (docs already covered by the
  // outage-note pin-context guard and the connection-string rule).
  {
    id: 'supabase-legacy-url',
    re: /https:\/\/[a-z]{20}\.supabase\.co/,
    scope: (path) =>
      /^supabase\/migrations\//.test(path) ||
      /^supabase\/functions\//.test(path) ||
      /^src\//.test(path) ||
      /^src-tauri\//.test(path) ||
      /^broker\//.test(path),
  },
];

/**
 * Scan text line by line. Findings carry the line number and rule id only, never
 * the match. `path` (repo-relative, forward slashes) is only used to evaluate a
 * rule's `scope`; rules without a `scope` apply to every path.
 * @param {string} text
 * @param {string} [path]
 * @returns {{ line: number, rule: string }[]}
 */
export function scanText(text, path = '') {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(IGNORE_MARKER)) return;
    for (const { id, re, scope, skip } of RULES) {
      if (scope && !scope(path)) continue;
      if (skip && skip(line)) continue;
      if (re.test(line)) findings.push({ line: i + 1, rule: id });
    }
  });
  return findings;
}

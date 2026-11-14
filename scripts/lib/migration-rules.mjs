// Rules for NEW app migrations (those not in migration-grandfathered.txt). See Plan 04b Task 1 and S8 REVIEW I5.
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

const blank = (s) => s.replace(/[^\n]/g, ' ');
const DO_BEFORE = /\bDO(?:\s+LANGUAGE\s+\w*)?\s*$/i;

/** plpgsql: BEGIN/THEN/ELSE/LOOP open a statement position, END [IF|LOOP|CASE] closes a block; same length, so lines hold. */
function plpgsqlStatements(body) {
  return body
    .replace(/\b(?:BEGIN|THEN|ELSE|LOOP)\b/gi, (m) => `;${' '.repeat(m.length - 1)}`)
    .replace(/\bEND\b/gi, (m) => ' '.repeat(m.length));
}

/** Blanks `BEGIN ATOMIC ... END` (SQL-standard function body; it runs when called), tracking CASE ... END nesting. */
function blankAtomicBodies(clean) {
  let out = '';
  let at = 0;
  for (const open of clean.matchAll(/\bBEGIN\s+ATOMIC\b/gi)) {
    if (open.index < at) continue;
    const from = open.index + open[0].length;
    let depth = 0;
    let end = clean.length;
    for (const t of clean.slice(from).matchAll(/\b(CASE|END)\b/gi)) {
      if (t[1].toUpperCase() === 'CASE') depth++;
      else if (depth-- === 0) { end = from + t.index + 3; break; }
    }
    out += clean.slice(at, open.index) + blank(clean.slice(open.index, end));
    at = end;
  }
  return out + clean.slice(at);
}

/**
 * Replaces comments, string literals, quoted identifiers and dollar-quoted bodies with spaces (line breaks kept), so a rule only
 * sees top-level statement text. Block comments nest, as in PostgreSQL; E'...' strings honour backslash escapes.
 * Bodies of anonymous DO blocks run at migration time, so they stay scanned (plpgsql block keywords neutralised); function bodies
 * and BEGIN ATOMIC bodies run later, by a caller, and are blanked. Accepted limit: SQL inside a string handed to EXECUTE is not seen.
 */
export function stripSqlNoise(sql) {
  return blankAtomicBodies(strip(sql));
}

function strip(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    const prev = i > 0 ? sql[i - 1] : '';
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'" || c === '"') {
      // E'...' (escape string): a backslash escapes the next character. The E must start a token.
      const escape = c === "'" && /[Ee]/.test(prev) && !(i > 1 && IDENT_CHAR.test(sql[i - 2]));
      let j = i + 1;
      while (j < sql.length) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) { j++; break; }
        else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === '$' && !IDENT_CHAR.test(prev)) {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        if (end !== -1 && DO_BEFORE.test(out)) {
          out += blank(tag[0]) + plpgsqlStatements(strip(sql.slice(i + tag[0].length, end))) + blank(tag[0]);
        } else {
          out += blank(sql.slice(i, stop));
        }
        i = stop;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const S = '(?:^|;)\\s*';
export const RULES = [
  { id: 'no-transaction-control', re: new RegExp(`${S}(?:BEGIN|START\\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\\b`, 'gi') },
  { id: 'no-role-ddl', re: new RegExp(`${S}(?:CREATE|ALTER|DROP)\\s+(?:ROLE|USER|GROUP)\\b`, 'gi') },
  // GRANT/REVOKE without ON is role membership (pg_auth_members is cluster-wide, like the role itself).
  { id: 'no-role-ddl', re: new RegExp(`${S}(?:GRANT|REVOKE)\\b(?:(?!\\bON\\b)[^;])*?\\b(?:TO|FROM)\\b`, 'gi') },
  { id: 'no-alter-database', re: new RegExp(`${S}(?:ALTER|CREATE|DROP)\\s+(?:DATABASE|TABLESPACE)\\b`, 'gi') },
  { id: 'no-alter-system', re: new RegExp(`${S}ALTER\\s+SYSTEM\\b`, 'gi') },
];

/** `[{ line, rule }]` for every violation in one migration's SQL text. */
export function scanMigration(sql) {
  const clean = stripSqlNoise(sql);
  const findings = [];
  for (const { id, re } of RULES) {
    for (const m of clean.matchAll(re)) {
      const skip = m[0].startsWith(';') ? 1 : 0; // a match may begin with the ';' of the previous statement: report the keyword's own line
      const keywordAt = m.index + skip + m[0].slice(skip).search(/\S/);
      findings.push({ line: clean.slice(0, keywordAt).split('\n').length, rule: id });
    }
  }
  return findings.sort((x, y) => x.line - y.line);
}

export const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

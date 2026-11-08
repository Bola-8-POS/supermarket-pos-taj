/**
 * Migration lint: new migrations (not in scripts/lib/migration-grandfathered.txt) must not carry their own transaction control
 * or cluster-wide DDL (roles, databases, system settings), must be named <14 digits>_<name>.sql and must have a version after every
 * grandfathered file. Findings are `file[:line]: rule`; the SQL text is never printed.
 *   node scripts/check-migrations.mjs [--dir supabase/migrations]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MIGRATION_NAME, scanMigration } from './lib/migration-rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function checkMigrations({ dir, grandfatheredText }) {
  const grandfathered = new Set(grandfatheredText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const present = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const findings = [];
  for (const name of [...grandfathered].sort()) if (!present.includes(name)) findings.push({ file: name, rule: 'grandfathered-missing' });
  const newest = (MIGRATION_NAME.exec([...grandfathered].sort().pop() ?? '') ?? [])[1] ?? '';
  const seen = new Map();
  for (const file of present) {
    const v = !grandfathered.has(file) && MIGRATION_NAME.exec(file)?.[1];
    if (v) seen.set(v, [...(seen.get(v) ?? []), file]);
  }
  const newFiles = present.filter((f) => !grandfathered.has(f));
  for (const file of newFiles) {
    const match = MIGRATION_NAME.exec(file);
    if (!match) {
      findings.push({ file, rule: 'migration-name' });
      continue;
    }
    // ordering is by the 14-digit version, not the whole name: reusing the newest grandfathered version is not "after" it
    if (match[1] <= newest) findings.push({ file, rule: 'migration-order' });
    if (seen.get(match[1]).length > 1) findings.push({ file, rule: 'duplicate-version' });
    for (const f of scanMigration(readFileSync(join(dir, file), 'utf8'))) findings.push({ file, line: f.line, rule: f.rule });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? process.argv[i + 1] : join(ROOT, 'supabase', 'migrations');
  const listPath = join(ROOT, 'scripts', 'lib', 'migration-grandfathered.txt');
  if (!existsSync(listPath)) {
    console.error('migration-grandfathered.txt is missing');
    process.exit(1);
  }
  const findings = checkMigrations({ dir, grandfatheredText: readFileSync(listPath, 'utf8') });
  for (const f of findings) console.error(`${f.file}${f.line ? `:${f.line}` : ''}: ${f.rule}`);
  console.log(findings.length ? `${findings.length} migration lint finding(s)` : 'migration lint: ok');
  process.exit(findings.length ? 1 : 0);
}

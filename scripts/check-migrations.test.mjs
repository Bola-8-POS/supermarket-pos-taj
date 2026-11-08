import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkMigrations } from './check-migrations.mjs';
import { scanMigration, stripSqlNoise } from './lib/migration-rules.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const rules = (sql) => scanMigration(sql).map((f) => f.rule);

describe('stripSqlNoise', () => {
  it('blanks comments, string literals, quoted identifiers and dollar-quoted bodies but keeps line breaks', () => {
    const sql = "-- BEGIN;\nSELECT 'COMMIT;' AS \"BEGIN\"; /* ROLLBACK; */\nSELECT $f$ BEGIN; $f$;\n";
    const out = stripSqlNoise(sql);
    expect(out.split('\n')).toHaveLength(sql.split('\n').length);
    expect(out).not.toMatch(/BEGIN|COMMIT|ROLLBACK/);
    expect(out).toContain('SELECT');
  });
  it('handles doubled quotes and nested block comments', () => {
    expect(stripSqlNoise("SELECT 'it''s COMMIT;';")).not.toMatch(/COMMIT/);
    expect(stripSqlNoise('/* a /* COMMIT; */ COMMIT; */ SELECT 1;')).not.toMatch(/COMMIT/);
  });
});

describe('scanMigration: violations', () => {
  it.each([
    ['BEGIN;\nSELECT 1;\nCOMMIT;\n', ['no-transaction-control', 'no-transaction-control']],
    ['begin transaction;\nselect 1;\n', ['no-transaction-control']],
    ['START TRANSACTION;\nSELECT 1;\nROLLBACK;\n', ['no-transaction-control', 'no-transaction-control']],
    ['SELECT 1;\nEND;\n', ['no-transaction-control']],
    ['CREATE ROLE helper NOLOGIN;\n', ['no-role-ddl']],
    ['create user u;\n', ['no-role-ddl']],
    ["ALTER ROLE authenticator SET statement_timeout = '8s';\n", ['no-role-ddl']],
    ['DROP ROLE helper;\n', ['no-role-ddl']],
    ['ALTER DATABASE postgres SET timezone = \'UTC\';\n', ['no-alter-database']],
    ["ALTER SYSTEM SET max_connections = 50;\n", ['no-alter-system']],
    // probes from the Plan 04b security review
    ["SELECT E'it\\'s'; COMMIT;\n", ['no-transaction-control']],
    ['START TRANSACTION READ WRITE;\nSELECT 1;\n', ['no-transaction-control']],
    ['SELECT 1;\nCOMMIT AND CHAIN;\n', ['no-transaction-control']],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;\n', ['no-transaction-control']],
    ['SELECT 1 AS a$b$;\nCOMMIT;\n', ['no-transaction-control']],
    ['GRANT authenticated TO helper;\n', ['no-role-ddl']],
    ['REVOKE authenticated FROM helper;\n', ['no-role-ddl']],
    ['CREATE DATABASE other;\n', ['no-alter-database']],
    ['DROP TABLESPACE fast;\n', ['no-alter-database']],
    // anonymous DO blocks run at migration time: their statements are scanned
    ["DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='x') THEN CREATE ROLE x; END IF; END $$;\n", ['no-role-ddl']],
    ['DO $$ BEGIN UPDATE t SET a=1; COMMIT; END $$;\n', ['no-transaction-control']],
    // a real COMMIT after a BEGIN ATOMIC body is still caught
    ['CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; END;\nCOMMIT;\n', ['no-transaction-control']],
  ])('flags %j', (sql, expected) => {
    expect(rules(sql)).toEqual(expected);
  });
  it('reports the line of the statement', () => {
    expect(scanMigration('SELECT 1;\n\nCOMMIT;\n')).toEqual([{ line: 3, rule: 'no-transaction-control' }]);
  });
});

describe('scanMigration: clean SQL', () => {
  it('does not flag a BEGIN ATOMIC function body (with or without a CASE expression)', () => {
    expect(scanMigration('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\n')).toEqual([]);
    expect(scanMigration('CREATE FUNCTION f() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT CASE WHEN true THEN 1 ELSE 2 END;\nEND;\n')).toEqual([]);
  });
  it('does not flag plpgsql control flow in a DO block, nor role DDL or COMMIT in a function body (it runs later, by a caller)', () => {
    expect(scanMigration('DO $$ BEGIN IF x THEN PERFORM 1; ELSE PERFORM 2; END IF; LOOP EXIT; END LOOP; END $$;\n')).toEqual([]);
    expect(scanMigration('CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN CREATE ROLE x; COMMIT; END $$;\n')).toEqual([]);
  });
  it('reports the right line for a statement inside a DO block', () => {
    expect(scanMigration('DO $$\nBEGIN\n  COMMIT;\nEND\n$$;\n')).toEqual([{ line: 3, rule: 'no-transaction-control' }]);
  });
  it('does not flag BEGIN/END of a function body, a DO block, or words inside strings and comments', () => {
    const sql = `
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  BEGIN
    PERFORM 2;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;
DO $do$ BEGIN RAISE NOTICE 'COMMIT; CREATE ROLE x'; END $do$;
-- ALTER SYSTEM SET x = 1;
COMMENT ON FUNCTION f() IS 'ALTER DATABASE is not run here; BEGIN; COMMIT;';
CREATE POLICY p ON t USING (role = 'cashier');
GRANT SELECT ON t TO anon;
NOTIFY pgrst, 'reload schema';
CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $fn1$
BEGIN
  PERFORM 1;
END;
$fn1$;
REVOKE ALL ON FUNCTION g() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION g() TO authenticated;
SELECT 'it''s fine' AS "COMMIT";
`;
    expect(scanMigration(sql)).toEqual([]);
  });
});

function fixtureDir(files, grandfathered) {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { dir, grandfatheredText: grandfathered.join('\n') };
}

describe('checkMigrations', () => {
  const old = '20260101000001_old.sql';
  it('ignores violations in grandfathered files', () => {
    const { dir, grandfatheredText } = fixtureDir({ [old]: 'BEGIN;\nCREATE ROLE x;\nCOMMIT;\n' }, [old]);
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([]);
  });
  it('fails a new migration that wraps itself in a transaction or creates a role', () => {
    const { dir, grandfatheredText } = fixtureDir({ [old]: 'SELECT 1;\n', '20260202000002_new.sql': 'BEGIN;\nCREATE ROLE x;\nCOMMIT;\n' }, [old]);
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([
      { file: '20260202000002_new.sql', line: 1, rule: 'no-transaction-control' },
      { file: '20260202000002_new.sql', line: 2, rule: 'no-role-ddl' },
      { file: '20260202000002_new.sql', line: 3, rule: 'no-transaction-control' },
    ]);
  });
  it('passes a clean new migration', () => {
    const { dir, grandfatheredText } = fixtureDir({ [old]: 'SELECT 1;\n', '20260202000002_new.sql': "CREATE TABLE t(id int);\nNOTIFY pgrst, 'reload schema';\n" }, [old]);
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([]);
  });
  it('fails a badly named new file and a new file that sorts before an existing one', () => {
    const { dir, grandfatheredText } = fixtureDir({ [old]: 'SELECT 1;\n', 'new.sql': 'SELECT 1;\n', '20250101000001_backdated.sql': 'SELECT 1;\n' }, [old]);
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([
      { file: '20250101000001_backdated.sql', rule: 'migration-order' },
      { file: 'new.sql', rule: 'migration-name' },
    ]);
  });
  it('fails a new file that reuses the newest grandfathered version, and new files that share a version', () => {
    const { dir, grandfatheredText } = fixtureDir(
      { [old]: 'SELECT 1;\n', '20260101000001_zzz.sql': 'SELECT 1;\n', '20261101000000_a.sql': 'SELECT 1;\n', '20261101000000_b.sql': 'SELECT 1;\n' },
      [old],
    );
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([
      { file: '20260101000001_zzz.sql', rule: 'migration-order' },
      { file: '20261101000000_a.sql', rule: 'duplicate-version' },
      { file: '20261101000000_b.sql', rule: 'duplicate-version' },
    ]);
  });
  it('fails when a grandfathered file has been deleted', () => {
    const { dir, grandfatheredText } = fixtureDir({}, [old]);
    expect(checkMigrations({ dir, grandfatheredText })).toEqual([{ file: old, rule: 'grandfathered-missing' }]);
  });
});

describe('the repository today', () => {
  it('has no finding, and every existing migration is grandfathered', () => {
    const dir = join(ROOT, 'supabase', 'migrations');
    const text = readFileSync(join(ROOT, 'scripts', 'lib', 'migration-grandfathered.txt'), 'utf8');
    expect(checkMigrations({ dir, grandfatheredText: text })).toEqual([]);
    const listed = text.split(/\r?\n/).filter(Boolean);
    expect(listed).toEqual(expect.arrayContaining(['20261002000001_pin_attempt_clear_for_staff.sql', '20261002000002_pin_attempt_refund.sql']));
    expect(listed).toEqual([...listed].sort());
    expect(listed).toEqual(readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().filter((f) => listed.includes(f)));
  });
});

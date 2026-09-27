import { describe, expect, it } from 'vitest';

import { IGNORE_MARKER, RULES, scanText } from './secret-rules.mjs';

/** Build a synthetic value that shapes like the given kind, never a real credential. */
const fake = {
  jwt: () => `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`,
  privateKey: () => '-----BEGIN RSA PRIVATE KEY-----',
  supabaseKey: () => `sb_secret_${'x'.repeat(20)}`,
  anthropicKey: () => `sk-ant-${'x'.repeat(24)}`,
  githubToken: () => `ghp_${'x'.repeat(24)}`,
  awsKey: () => `AKIA${'A'.repeat(16)}`,
};

function ruleIds(findings) {
  return findings.map((f) => f.rule);
}

describe('scanText: one positive and one negative fixture per rule', () => {
  it('jwt', () => {
    expect(ruleIds(scanText(`token = "${fake.jwt()}"`))).toContain('jwt');
    expect(ruleIds(scanText('token = "not-a-jwt"'))).not.toContain('jwt');
  });

  it('private-key-header', () => {
    expect(ruleIds(scanText(fake.privateKey()))).toContain('private-key-header');
    expect(ruleIds(scanText('this is not a key header'))).not.toContain('private-key-header');
  });

  it('supabase-key', () => {
    expect(ruleIds(scanText(fake.supabaseKey()))).toContain('supabase-key');
    expect(ruleIds(scanText('sb_publishable = short'))).not.toContain('supabase-key');
  });

  it('anthropic-key', () => {
    expect(ruleIds(scanText(fake.anthropicKey()))).toContain('anthropic-key');
    expect(ruleIds(scanText('sk-not-anthropic-shaped'))).not.toContain('anthropic-key');
  });

  it('github-token', () => {
    expect(ruleIds(scanText(fake.githubToken()))).toContain('github-token');
    expect(ruleIds(scanText('ghp_tooshort'))).not.toContain('github-token');
  });

  it('aws-access-key', () => {
    expect(ruleIds(scanText(fake.awsKey()))).toContain('aws-access-key');
    expect(ruleIds(scanText('AKIA_not_valid_shape'))).not.toContain('aws-access-key');
  });

  it('pin-literal', () => {
    expect(ruleIds(scanText('the staff PIN is 483920'))).toContain('pin-literal');
    expect(ruleIds(scanText('the staff badge is 483920'))).not.toContain('pin-literal');
  });

  it('pin-assignment', () => {
    expect(ruleIds(scanText('pin: 483920'))).toContain('pin-assignment');
    expect(ruleIds(scanText('spin: 483920'))).not.toContain('pin-assignment'); // word boundary
  });

  it('credential-assignment (default path, no scope)', () => {
    expect(ruleIds(scanText('password: "s0meLongSecretValue"'))).toContain('credential-assignment');
    expect(ruleIds(scanText('password: short'))).not.toContain('credential-assignment');
  });

  it('credential-assignment skips values starting with env(', () => {
    const findings = scanText('secret = "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"', 'supabase/config.toml');
    expect(ruleIds(findings)).not.toContain('credential-assignment');
  });

  it('repeated-digits is scoped to *.md, supabase/seed.sql, scripts/seed-*.ts', () => {
    expect(ruleIds(scanText('pin 483920 555555', 'notes.md'))).toContain('repeated-digits');
    expect(ruleIds(scanText('pin 555555', 'supabase/seed.sql'))).toContain('repeated-digits');
    expect(ruleIds(scanText('pin 555555', 'scripts/seed-demo.ts'))).toContain('repeated-digits');
    expect(ruleIds(scanText('pin 555555', 'src/entities/staff/fixture.ts'))).not.toContain('repeated-digits');
    expect(ruleIds(scanText('pin 555555'))).not.toContain('repeated-digits'); // no path => unscoped rule does not fire
  });

  it('repeated-digits does not fire inside a UUID segment (hyphen-bounded run)', () => {
    expect(
      ruleIds(scanText('id 11111111-1111-1111-1111-111111111111', 'supabase/seed.sql')),
    ).not.toContain('repeated-digits');
    // still fires on a genuine repeated-digit PIN alongside a UUID on the same line
    expect(
      ruleIds(scanText('pin 555555 near 11111111-1111-1111-1111-111111111111', 'supabase/seed.sql')),
    ).toContain('repeated-digits');
  });

  it('pin-env-assignment: env-style PIN names, any file', () => {
    expect(ruleIds(scanText('E2E_ADMIN_PIN=999999'))).toContain('pin-env-assignment');
    expect(ruleIds(scanText('E2E_REMOTE_ADMIN_PIN: "999999"'))).toContain('pin-env-assignment');
    expect(ruleIds(scanText('E2E_ADMIN_PIN=${PIN}'))).not.toContain('pin-env-assignment');
    expect(ruleIds(scanText('pinned=999999'))).not.toContain('pin-env-assignment'); // lowercase, not an env-style name
  });

  it('pin-context fires on *.md within an 80-char window, not elsewhere', () => {
    expect(ruleIds(scanText('the staff pin was later confirmed as 401928 by the manager', 'note.md'))).toContain(
      'pin-context',
    );
    expect(ruleIds(scanText('the staff pin was later confirmed as 401928', 'note.ts'))).not.toContain('pin-context');
    expect(ruleIds(scanText('401928 is just a number with no pin word nearby', 'note.md'))).not.toContain(
      'pin-context',
    );
  });

  it('connection-string flags a real password but not the local default or a placeholder', () => {
    expect(ruleIds(scanText('postgresql://postgres.abcdefghijklmnop:RealPassw0rd1@aws-0.pooler.supabase.com:5432/postgres'))).toContain(
      'connection-string',
    );
    expect(ruleIds(scanText('postgresql://postgres:postgres@127.0.0.1:54322/postgres'))).not.toContain(
      'connection-string',
    );
    expect(
      ruleIds(scanText('postgresql://postgres.abcdefghijklmnop:<DB_PASSWORD>@aws-0.pooler.supabase.com:5432/postgres')),
    ).not.toContain('connection-string');
  });

  it('supabase-legacy-url is scoped to code paths, not docs', () => {
    expect(ruleIds(scanText("url := 'https://abcdefghijklmnopqrst.supabase.co'", 'supabase/migrations/x.sql'))).toContain(
      'supabase-legacy-url',
    );
    expect(ruleIds(scanText('https://abcdefghijklmnopqrst.supabase.co', 'docs/note.md'))).not.toContain(
      'supabase-legacy-url',
    );
  });
});

describe('IGNORE_MARKER', () => {
  it('skips a matching line that carries the marker', () => {
    const line = `token = "${fake.jwt()}" // secret-scan-ignore`;
    expect(scanText(line)).toEqual([]);
  });
});

describe('RULES', () => {
  it('is exported as an array of {id, re} with no g flag', () => {
    expect(Array.isArray(RULES)).toBe(true);
    for (const rule of RULES) {
      expect(typeof rule.id).toBe('string');
      expect(rule.re).toBeInstanceOf(RegExp);
      expect(rule.re.flags).not.toContain('g');
    }
  });
});

describe('scanText findings shape', () => {
  it('returns only {line, rule}, never the matched value', () => {
    const findings = scanText(`line one\ntoken = "${fake.jwt()}"\nline three`);
    expect(findings).toEqual([{ line: 2, rule: 'jwt' }]);
  });
});

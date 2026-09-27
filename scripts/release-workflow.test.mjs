import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseYml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const ciYml = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const resetDemoYml = readFileSync(join(ROOT, '.github', 'workflows', 'reset-demo.yml'), 'utf8');

describe('release.yml: export instead of mirror', () => {
  it('never uses git push --mirror', () => {
    expect(releaseYml).not.toMatch(/push\s+--mirror/);
  });

  it('never embeds a credential directly in a remote URL (x-access-token:$VAR@)', () => {
    expect(releaseYml).not.toMatch(/:\/\/[^/@\s]+:\$[^/@\s]*@/);
  });

  it('every `git ... push` line in the export step clears the credential helper', () => {
    const pushLines = releaseYml.split('\n').filter((l) => /^\s*git\b.*\bpush\b/.test(l));
    expect(pushLines.length).toBeGreaterThan(0);
    for (const line of pushLines) {
      expect(line).toMatch(/-c credential\.helper=/);
    }
  });

  it('the export step checks for a credential in a remote URL', () => {
    expect(releaseYml).toMatch(/remote -v.*[\s\S]*?FAILED: credential in a/);
  });

  it('the cleanup step runs under if: always() and removes the askpass file', () => {
    const cleanupIndex = releaseYml.indexOf('Clean up materialized secrets');
    expect(cleanupIndex).toBeGreaterThan(-1);
    const cleanupBlock = releaseYml.slice(cleanupIndex, cleanupIndex + 2000);
    expect(cleanupBlock).toMatch(/if:\s*always\(\)/);
    expect(cleanupBlock).toMatch(/askpass/);
  });

  it('sync-customers carries its own repository guard', () => {
    const jobIndex = releaseYml.indexOf('sync-customers:');
    expect(jobIndex).toBeGreaterThan(-1);
    const jobHeader = releaseYml.slice(jobIndex, jobIndex + 400);
    expect(jobHeader).toMatch(/github\.repository == 'Bola-8-POS\/supermarket-pos'/);
  });

  it('the checkout step no longer requests fetch-depth: 0 (only --mirror needed full history)', () => {
    expect(releaseYml).not.toMatch(/fetch-depth:\s*0/);
  });
});

describe('ci.yml: fork guard on both jobs', () => {
  it('every job guard refuses a fork pull request', () => {
    const guards = ciYml.match(/if:\s*github\.repository ==[^\n]*/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    for (const guard of guards) {
      expect(guard).toMatch(/pull_request\.head\.repo\.full_name == github\.repository/);
    }
  });

  it('runs a customer export dry-run and a secret scan', () => {
    expect(ciYml).toMatch(/export-customer-tree\.mjs/);
    expect(ciYml).toMatch(/check-secrets\.mjs/);
  });

  it('runs the e2e-tools vitest project', () => {
    expect(ciYml).toMatch(/vitest run --project e2e-tools/);
  });
});

describe('workflow YAML validity', () => {
  it('release.yml, ci.yml and reset-demo.yml all parse as valid YAML', () => {
    expect(() => yaml.load(releaseYml)).not.toThrow();
    expect(() => yaml.load(ciYml)).not.toThrow();
    expect(() => yaml.load(resetDemoYml)).not.toThrow();
  });
});

/** On Windows a bare `bash` resolves to the WSL launcher, which fails on a
 * machine without a distribution (the self-hosted runner). Prefer Git's bash. */
function resolveBash() {
  if (process.platform !== 'win32') return 'bash';
  for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files']) {
    if (!base) continue;
    const candidate = join(base, 'Git', 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'bash';
}

describe('reset-demo.yml: guard step asserts the demo project ref', () => {
  /** Runs the guard step's exact embedded script (extracted from the parsed
   * YAML, never retyped) in bash, the same shell `ubuntu-latest` uses, with a
   * fixture DEMO_SUPABASE_PROJECT_REF. Never touches the real secret or a
   * real project: only the env var and the exit code/output are observed. */
  function runGuardScript(ref) {
    const parsed = yaml.load(resetDemoYml);
    const guardStep = parsed.jobs.reset.steps.find(
      (s) => s.name === 'Guard against resetting a real customer project',
    );
    expect(guardStep).toBeDefined();
    try {
      const stdout = execFileSync(resolveBash(), ['-c', guardStep.run], {
        cwd: ROOT,
        env: { ...process.env, DEMO_SUPABASE_PROJECT_REF: ref },
        encoding: 'utf8',
      });
      return { code: 0, output: stdout };
    } catch (err) {
      return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('passes when the ref matches the demo entry', () => {
    const customers = JSON.parse(readFileSync(join(ROOT, 'customers', 'customers.json'), 'utf8'));
    const demoRef = customers.find((c) => c.name === 'demo').supabase_project_ref;
    const result = runGuardScript(demoRef);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/OK: DEMO_SUPABASE_PROJECT_REF matches the demo entry/);
  });

  it('fails loudly when the ref does not match any customer (RED before this fix existed)', () => {
    const result = runGuardScript('not-a-listed-ref-00000000000');
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/does not match the demo entry/);
  });

  it('still fails when the ref clashes with a non-demo customer', () => {
    const customers = JSON.parse(readFileSync(join(ROOT, 'customers', 'customers.json'), 'utf8'));
    const otherCustomer = customers.find((c) => c.name !== 'demo' && c.supabase_project_ref);
    const result = runGuardScript(otherCustomer.supabase_project_ref);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/refusing to reset a real customer project/);
  });
});

import { describe, expect, it } from 'vitest';
import { buildSteps, parseEslint, renderTable, runStep } from './gate.mjs';

describe('gate', () => {
  it('marks a failing step FAIL with its first failure line', () => {
    const r = runStep({ name: 'fake', cmd: 'node -e "console.error(\'boom: broken thing\'); process.exit(1)"' });
    expect(r.ok).toBe(false);
    const table = renderTable([{ name: 'ok', secs: '0.1', ok: true, detail: '' }, r]);
    expect(table).toMatch(/fake\s+FAIL .*boom: broken thing/);
    expect(table).toContain('GATE: FAIL (1)');
  });

  it('passes when every step passes', () => {
    const r = runStep({ name: 'fine', cmd: 'node -e "0"' });
    expect(renderTable([r])).toContain('GATE: PASS');
  });

  it('counts only severity-2 eslint messages', () => {
    const json = JSON.stringify([{ filePath: 'a.ts', messages: [{ severity: 2, line: 3, ruleId: 'r', message: 'm' }, { severity: 1, line: 4, message: 'w' }] }]);
    expect(parseEslint(json).errors).toBe(1);
  });

  it('runs every lint:* script as its own step', () => {
    const names = buildSteps({ lint: 'x', 'lint:a': 'y', 'lint:fix': 'z' }).map((s) => s.name);
    expect(names).toContain('lint:a');
    expect(names).not.toContain('lint:fix');
    expect(names).not.toContain('lint');
  });
});

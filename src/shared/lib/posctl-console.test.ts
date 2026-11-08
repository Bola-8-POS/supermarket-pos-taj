import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openPosctlConsole } from './posctl-console';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

beforeEach(() => {
  invoke.mockReset();
});

describe('openPosctlConsole', () => {
  it('invokes the command with only the action and returns the outcome', async () => {
    invoke.mockResolvedValue('Launched');
    const r = await openPosctlConsole('AddTill');
    expect(invoke).toHaveBeenCalledWith('posctl_open_console', { action: 'AddTill' });
    expect(r).toEqual({ ok: true, data: 'Launched' });
  });
  it('maps an unknown answer and a rejection to errors', async () => {
    invoke.mockResolvedValueOnce('Weird');
    expect((await openPosctlConsole('SetUpServer')).ok).toBe(false);
    invoke.mockRejectedValueOnce(new Error('/secret/path'));
    const r = await openPosctlConsole('SetUpServer');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).not.toContain('secret');
  });
});

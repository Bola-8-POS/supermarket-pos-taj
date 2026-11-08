import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  startDemo: vi.fn(),
  activateLicense: vi.fn(),
  heartbeatLicense: vi.fn(),
  FATAL_LICENSE_CODES: new Set<string>(),
  DEMO_ERROR_CODES: new Set(['DEMO_ALREADY_USED', 'RATE_LIMITED']),
}));
vi.mock('./token', async importOriginal => ({
  ...(await importOriginal<typeof TokenModule>()),
  verifyToken: vi.fn(),
}));

import { importOfflineToken, resetTerminalForNewDemo, runHeartbeat, startDemoTrial } from './actions';
import { heartbeatLicense, startDemo } from './client';
import { useLicenseStore } from './store';
import { getTerminalId } from './terminal-id';
import type * as TokenModule from './token';
import { verifyToken } from './token';

const payloadFor = (terminal_id: string) => ({
  v: 1 as const, tenant_id: 't', tenant_slug: 'demo-1', tenant_name: 'Demo', terminal_id,
  plan: 'demo' as const, status: 'active' as const, period_end: '2026-09-28T00:00:00Z',
  grace_days: 0, updates_until: null, max_terminals: 1, features: ['promotions'],
  issued_at: '2026-09-14T00:00:00Z', lease_until: '2026-09-28T00:00:00Z',
});

describe('startDemoTrial', () => {
  beforeEach(() => {
    localStorage.clear();
    useLicenseStore.getState().clearLicense(null);
  });

  it('stores the token and the demo license key so heartbeats work', async () => {
    vi.mocked(startDemo).mockResolvedValue({ ok: true, data: { token: 'tok', license_key: 'DEMO-KEY' } });
    vi.mocked(verifyToken).mockResolvedValue({ ok: true, data: payloadFor(getTerminalId()) });
    const res = await startDemoTrial();
    expect(res.ok).toBe(true);
    expect(useLicenseStore.getState()).toMatchObject({ token: 'tok', licenseKey: 'DEMO-KEY' });
  });

  it('resetTerminalForNewDemo mints a new terminal id before re-provisioning', async () => {
    const before = getTerminalId();
    vi.mocked(startDemo).mockImplementation(async () => ({ ok: true, data: { token: 'tok2', license_key: 'K2' } }));
    vi.mocked(verifyToken).mockImplementation(async () => ({ ok: true, data: payloadFor(getTerminalId()) }));
    const res = await resetTerminalForNewDemo();
    expect(res.ok).toBe(true);
    expect(getTerminalId()).not.toBe(before);
  });
});

describe('offline budget resets on genuine licence contact', () => {
  const spent = { runningMsSinceHeartbeat: 500 * 3_600_000, lastTickAt: 1 };
  const paid = (issued_at: string) => ({
    ...payloadFor(getTerminalId()), plan: 'monthly' as const, features: null, issued_at,
  });

  beforeEach(() => {
    localStorage.clear();
    useLicenseStore.getState().clearLicense(null);
    useLicenseStore.setState({ offlineBudget: spent });
  });

  it('a successful heartbeat clears the offline budget', async () => {
    useLicenseStore.setState({ token: 'old', licenseKey: 'KEY', payload: paid('2026-09-01T00:00:00Z') });
    vi.mocked(heartbeatLicense).mockResolvedValue({ ok: true, data: { token: 'fresh' } });
    vi.mocked(verifyToken).mockResolvedValue({ ok: true, data: paid('2026-09-20T00:00:00Z') });
    await expect(runHeartbeat()).resolves.toBe('refreshed');
    expect(useLicenseStore.getState().offlineBudget.runningMsSinceHeartbeat).toBe(0);
  });

  it('a skipped heartbeat leaves the budget alone', async () => {
    useLicenseStore.setState({ token: 'old', licenseKey: 'KEY', payload: paid('2026-09-01T00:00:00Z') });
    vi.mocked(heartbeatLicense).mockResolvedValue({
      ok: false, error: { code: 'NETWORK_OFFLINE', message: 'offline' },
    } as never);
    await expect(runHeartbeat()).resolves.toBe('skipped');
    expect(useLicenseStore.getState().offlineBudget).toEqual(spent);
  });

  it('pasting a newer offline token clears the budget', async () => {
    useLicenseStore.setState({ token: 'old', payload: paid('2026-09-01T00:00:00Z') });
    vi.mocked(verifyToken).mockResolvedValue({ ok: true, data: paid('2026-09-20T00:00:00Z') });
    expect((await importOfflineToken('newer')).ok).toBe(true);
    expect(useLicenseStore.getState().offlineBudget.runningMsSinceHeartbeat).toBe(0);
  });

  it('re-pasting an older or identical offline token does not clear the budget', async () => {
    useLicenseStore.setState({ token: 'cur', payload: paid('2026-09-20T00:00:00Z') });
    vi.mocked(verifyToken).mockResolvedValue({ ok: true, data: paid('2026-09-20T00:00:00Z') });
    expect((await importOfflineToken('same')).ok).toBe(true);
    expect(useLicenseStore.getState().offlineBudget).toEqual(spent);
  });
});

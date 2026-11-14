import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  startDemo: vi.fn(),
  activateLicense: vi.fn(),
  heartbeatLicense: vi.fn(),
  FATAL_LICENSE_CODES: new Set<string>(),
  DEMO_ERROR_CODES: new Set<string>(),
}));
vi.mock('./token', async importOriginal => ({
  ...(await importOriginal<typeof TokenModule>()),
  verifyToken: vi.fn(),
}));

import { runHeartbeat } from './actions';
import { heartbeatLicense } from './client';
import { getEffectiveNow, useLicenseStore } from './store';
import { getTerminalId } from './terminal-id';
import type * as TokenModule from './token';
import { verifyToken } from './token';

describe('trusted server time', () => {
  beforeEach(() => {
    localStorage.clear();
    useLicenseStore.setState({
      maxSeenNow: 0,
      lastTrustedServerTime: null,
      offlineBudget: { runningMsSinceHeartbeat: 400 * 3_600_000, lastTickAt: 1 },
    });
  });

  it('advances the clock ratchet to a trusted server time', () => {
    const store = useLicenseStore.getState();
    store.noteTrustedServerTime(2_000_000_000_000);
    expect(useLicenseStore.getState().maxSeenNow).toBeGreaterThanOrEqual(2_000_000_000_000);
    expect(getEffectiveNow()).toBeGreaterThanOrEqual(2_000_000_000_000);
  });

  it('ignores a server time earlier than one already trusted', () => {
    useLicenseStore.getState().noteTrustedServerTime(2_000_000_000_000);
    useLicenseStore.getState().noteTrustedServerTime(1_000_000_000_000);
    expect(useLicenseStore.getState().lastTrustedServerTime).toBe(2_000_000_000_000);
  });

  it('ignores a non-finite server time', () => {
    useLicenseStore.getState().noteTrustedServerTime(Number.NaN);
    expect(useLicenseStore.getState().lastTrustedServerTime).toBeNull();
    expect(useLicenseStore.getState().maxSeenNow).toBe(0);
  });

  it('a successful heartbeat records trusted time and clears the offline budget', async () => {
    const issuedAt = '2099-01-01T00:00:00Z';
    useLicenseStore.setState({ token: 'old', licenseKey: 'KEY' });
    vi.mocked(heartbeatLicense).mockResolvedValue({ ok: true, data: { token: 'fresh' } });
    vi.mocked(verifyToken).mockResolvedValue({
      ok: true,
      data: {
        v: 1, tenant_id: 't', tenant_slug: 's', tenant_name: 'S', terminal_id: getTerminalId(),
        plan: 'monthly', status: 'active', period_end: null, grace_days: 7, updates_until: null,
        max_terminals: 1, issued_at: issuedAt, lease_until: '2099-03-01T00:00:00Z', features: null,
      },
    });
    await expect(runHeartbeat()).resolves.toBe('refreshed');
    const s = useLicenseStore.getState();
    // The signed token's issued_at is the licence server's own clock at signing time.
    expect(s.lastTrustedServerTime).toBe(Date.parse(issuedAt));
    expect(s.maxSeenNow).toBe(Date.parse(issuedAt));
    expect(s.offlineBudget.runningMsSinceHeartbeat).toBe(0);
  });
});

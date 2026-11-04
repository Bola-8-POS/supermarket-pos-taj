import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeartbeat } from './actions';
import type * as ConfigModule from './config';
import { OFFLINE_BUDGET_HOURS, OFFLINE_TICK_MS } from './offline-budget';
import { useLicenseStore } from './store';
import { useLicenseHeartbeat } from './useLicenseHeartbeat';

vi.mock('./config', async importOriginal => ({
  ...(await importOriginal<typeof ConfigModule>()),
  isLicenseEnforced: () => true,
}));
vi.mock('./actions', () => ({
  revalidateStoredToken: vi.fn(() => Promise.resolve()),
  runHeartbeat: vi.fn(() => Promise.resolve('skipped')),
}));
const mockIsOnline = vi.fn(() => true);
vi.mock('@shared/lib/connectivity', () => ({ isOnline: () => mockIsOnline() }));

const BUDGET_MS = OFFLINE_BUDGET_HOURS * 3_600_000;

describe('useLicenseHeartbeat — revalidation retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runHeartbeat).mockClear();
    mockIsOnline.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const callsAfterOneTick = async () => {
    renderHook(() => { useLicenseHeartbeat(); });
    await vi.advanceTimersByTimeAsync(0); // the mount-time revalidate().then(runHeartbeat)
    const atMount = vi.mocked(runHeartbeat).mock.calls.length;
    await vi.advanceTimersByTimeAsync(OFFLINE_TICK_MS);
    return vi.mocked(runHeartbeat).mock.calls.length - atMount;
  };

  it('retries the heartbeat every tick while revalidation is required and the terminal is online', async () => {
    useLicenseStore.setState({ licenseKey: 'KEY', offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS * 0.6, lastTickAt: Date.now() } });
    expect(await callsAfterOneTick()).toBe(1);
  });

  it('retries every tick while restricted even below the revalidation threshold', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    useLicenseStore.setState({
      licenseKey: 'KEY',
      payload: {
        v: 1, tenant_id: 't', tenant_slug: 's', tenant_name: 'S', terminal_id: 'x', plan: 'monthly',
        status: 'active', period_end: null, grace_days: 7, updates_until: null, max_terminals: 1,
        issued_at: past, lease_until: past, features: null,
      },
      offlineBudget: { runningMsSinceHeartbeat: 0, lastTickAt: Date.now() },
    });
    expect(await callsAfterOneTick()).toBe(1);
    useLicenseStore.setState({ payload: null, licenseKey: null });
  });

  it('does not retry while offline', async () => {
    mockIsOnline.mockReturnValue(false);
    useLicenseStore.setState({ licenseKey: 'KEY', offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS * 0.6, lastTickAt: Date.now() } });
    expect(await callsAfterOneTick()).toBe(0);
  });

  it('does not retry below the revalidation threshold', async () => {
    useLicenseStore.setState({ offlineBudget: { runningMsSinceHeartbeat: 0, lastTickAt: Date.now() } });
    expect(await callsAfterOneTick()).toBe(0);
  });
});

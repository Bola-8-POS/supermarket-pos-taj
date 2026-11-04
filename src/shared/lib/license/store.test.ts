import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConfigModule from './config';
import { OFFLINE_BUDGET_HOURS, OFFLINE_TICK_MS } from './offline-budget';
import { currentLicenseEvaluation, requiresRevalidation, useLicenseStore } from './store';
import type { LicensePayload } from './types';

vi.mock('./config', async importOriginal => ({
  ...(await importOriginal<typeof ConfigModule>()),
  isLicenseEnforced: () => true,
}));

const BUDGET_MS = OFFLINE_BUDGET_HOURS * 3_600_000;
/** The vendor's issue-offline-token accepts lease_days up to 3650. */
const LONGEST_TOKEN_MS = 3650 * 86_400_000;
const running = () => useLicenseStore.getState().offlineBudget.runningMsSinceHeartbeat;

describe('licence store — offline runtime budget', () => {
  beforeEach(() => {
    localStorage.clear();
    useLicenseStore.setState({
      offlineBudget: { runningMsSinceHeartbeat: 0, lastTickAt: 1_000_000 },
      maxSeenNow: 1_000_000,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accrues one tick interval per tick while the system clock is frozen', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    for (let i = 0; i < 5; i += 1) useLicenseStore.getState().accrueOfflineRuntime();
    expect(running()).toBe(5 * OFFLINE_TICK_MS);
  });

  it('treats a clock wound backwards like a frozen one, so it still accrues', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    useLicenseStore.getState().accrueOfflineRuntime();
    const afterFirst = running();
    now.mockReturnValue(1_000_000);
    useLicenseStore.getState().accrueOfflineRuntime();
    expect(running()).toBe(afterFirst + OFFLINE_TICK_MS);
  });

  it('clears the budget when the licence server is reached', () => {
    useLicenseStore.setState({ offlineBudget: { runningMsSinceHeartbeat: 99 * 3_600_000, lastTickAt: 5 } });
    useLicenseStore.getState().markHeartbeat();
    expect(running()).toBe(0);
  });

  it('loads a tampered negative counter as fully spent, whatever budget applies', async () => {
    localStorage.setItem(
      'pos.license',
      JSON.stringify({ state: { offlineBudget: { runningMsSinceHeartbeat: -5, lastTickAt: 0 } }, version: 0 })
    );
    await useLicenseStore.persist.rehydrate();
    expect(running()).toBeGreaterThanOrEqual(LONGEST_TOKEN_MS);
  });

  it('loads an over-budget counter as still spent', async () => {
    localStorage.setItem(
      'pos.license',
      JSON.stringify({ state: { offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS * 3, lastTickAt: 0 } }, version: 0 })
    );
    await useLicenseStore.persist.rehydrate();
    expect(running()).toBe(BUDGET_MS * 3);
  });

  it('starts a fresh budget for a record persisted before the budget existed', async () => {
    localStorage.setItem('pos.license', JSON.stringify({ state: { token: null, maxSeenNow: 0 }, version: 0 }));
    await useLicenseStore.persist.rehydrate();
    expect(running()).toBe(0);
  });
});

describe('licence store — evaluation uses the offline budget', () => {
  const far = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const paid: LicensePayload = {
    v: 1, tenant_id: 't', tenant_slug: 's', tenant_name: 'S', terminal_id: 'x', plan: 'monthly',
    status: 'active', period_end: far(200), grace_days: 7, updates_until: null, max_terminals: 1,
    issued_at: far(0), lease_until: far(50), features: null,
  };

  it('restricts a valid lease once the stored budget is spent', () => {
    useLicenseStore.setState({
      payload: paid,
      licenseKey: 'KEY',
      maxSeenNow: 0,
      offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS, lastTickAt: 0 },
    });
    expect(currentLicenseEvaluation()).toEqual({ state: 'restricted', reason: 'offline_budget_spent' });
  });
});

describe('requiresRevalidation', () => {
  it('is false at or below half the budget', () => {
    useLicenseStore.setState({ licenseKey: 'KEY', offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS / 2, lastTickAt: 0 } });
    expect(requiresRevalidation()).toBe(false);
  });

  it('is true above half the budget, until the licence server is reached', () => {
    useLicenseStore.setState({ licenseKey: 'KEY', offlineBudget: { runningMsSinceHeartbeat: BUDGET_MS * 0.6, lastTickAt: 0 } });
    expect(requiresRevalidation()).toBe(true);
    useLicenseStore.getState().markHeartbeat();
    expect(requiresRevalidation()).toBe(false);
  });
});

describe('offline-token stores (no licence key, so no heartbeat is possible)', () => {
  const DAY = 86_400_000;
  const yearToken: LicensePayload = {
    v: 1, tenant_id: 't', tenant_slug: 's', tenant_name: 'S', terminal_id: 'x', plan: 'yearly',
    status: 'active', period_end: null, grace_days: 7, updates_until: null, max_terminals: 1,
    issued_at: new Date(Date.now() - DAY).toISOString(),
    lease_until: new Date(Date.now() + 364 * DAY).toISOString(), features: null,
  };

  it('keeps selling past half the policy budget, because nothing could revalidate it', () => {
    useLicenseStore.setState({
      payload: yearToken, licenseKey: null, maxSeenNow: 0,
      offlineBudget: { runningMsSinceHeartbeat: 400 * 3_600_000, lastTickAt: 0 },
    });
    expect(requiresRevalidation()).toBe(false);
    expect(currentLicenseEvaluation()).toEqual({ state: 'active' });
  });

  it("is still bounded under a frozen clock — by the signed token's own lease length", () => {
    useLicenseStore.setState({
      payload: yearToken, licenseKey: null, maxSeenNow: 0,
      offlineBudget: { runningMsSinceHeartbeat: 365 * DAY, lastTickAt: 0 },
    });
    expect(currentLicenseEvaluation()).toEqual({ state: 'restricted', reason: 'offline_budget_spent' });
  });
});

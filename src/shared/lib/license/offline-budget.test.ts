import { describe, it, expect } from 'vitest';
import {
  accrueRuntime,
  budgetConsumedFraction,
  offlineBudgetMs,
  resetBudget,
  sanitizeBudget,
  OFFLINE_BUDGET_HOURS,
} from './offline-budget';

const MINUTE = 60_000;
const BUDGET_MS = OFFLINE_BUDGET_HOURS * 3_600_000;
/** The vendor's issue-offline-token accepts lease_days up to 3650. */
const LONGEST_TOKEN_MS = 3650 * 86_400_000;

describe('offline runtime budget', () => {
  it('accrues the elapsed time between ticks', () => {
    const start = resetBudget(1_000_000);
    const after = accrueRuntime(start, 1_000_000 + 5 * MINUTE, 2 * MINUTE);
    expect(after.runningMsSinceHeartbeat).toBe(2 * MINUTE); // capped per tick
  });

  it('accrues nothing when the clock goes backwards', () => {
    const start = { runningMsSinceHeartbeat: 10 * MINUTE, lastTickAt: 1_000_000 };
    const after = accrueRuntime(start, 900_000, 2 * MINUTE);
    expect(after.runningMsSinceHeartbeat).toBe(10 * MINUTE);
    expect(after.lastTickAt).toBe(900_000);
  });

  it('keeps accruing even when the clock is frozen, because ticks still happen', () => {
    // A frozen wall clock still produces ticks; the cap means each contributes at most maxTickGap,
    // but a minimum of one tick interval must still count or freezing would pause the budget.
    let b = resetBudget(1_000_000);
    for (let i = 0; i < 10; i += 1) {
      b = accrueRuntime(b, 1_000_000, 2 * MINUTE);
    }
    expect(b.runningMsSinceHeartbeat).toBeGreaterThan(0);
  });

  it('credits a full tick interval when the clock only crawls forward', () => {
    // A clock wound back almost a minute every minute advances 1 ms per tick; that must not
    // slow the budget to 1 ms per real minute.
    let b = resetBudget(1_000_000);
    for (let i = 1; i <= 10; i += 1) {
      b = accrueRuntime(b, 1_000_000 + i, 2 * MINUTE);
    }
    expect(b.runningMsSinceHeartbeat).toBe(10 * MINUTE);
  });

  it('reports the consumed fraction against the budget', () => {
    const full = { runningMsSinceHeartbeat: OFFLINE_BUDGET_HOURS * 3_600_000, lastTickAt: 0 };
    expect(budgetConsumedFraction(full)).toBeCloseTo(1, 5);
    const half = { runningMsSinceHeartbeat: (OFFLINE_BUDGET_HOURS / 2) * 3_600_000, lastTickAt: 0 };
    expect(budgetConsumedFraction(half)).toBeCloseTo(0.5, 5);
  });

  it('resets to zero after a successful heartbeat', () => {
    const spent = { runningMsSinceHeartbeat: 100 * 3_600_000, lastTickAt: 5 };
    expect(resetBudget(10).runningMsSinceHeartbeat).toBe(0);
    expect(spent.runningMsSinceHeartbeat).toBe(100 * 3_600_000); // pure, no mutation
  });
});

describe('sanitizeBudget (persisted value on load)', () => {
  const NOW = 5_000_000;

  it('starts a fresh budget when nothing was persisted (first run or upgrade)', () => {
    expect(sanitizeBudget(undefined, NOW)).toEqual({ runningMsSinceHeartbeat: 0, lastTickAt: NOW });
  });

  it('keeps a well-formed value as is', () => {
    const b = { runningMsSinceHeartbeat: 3 * MINUTE, lastTickAt: 4_000_000 };
    expect(sanitizeBudget(b, NOW)).toEqual(b);
  });

  it('keeps an over-budget value as is — clamping it down would hand back running time', () => {
    const b = { runningMsSinceHeartbeat: BUDGET_MS * 10, lastTickAt: 4_000_000 };
    expect(sanitizeBudget(b, NOW).runningMsSinceHeartbeat).toBe(BUDGET_MS * 10);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '0'],
  ])('treats a %s counter as fully spent, never as zero', (_label, value) => {
    const b = { runningMsSinceHeartbeat: value, lastTickAt: 4_000_000 };
    expect(budgetConsumedFraction(sanitizeBudget(b, NOW), LONGEST_TOKEN_MS)).toBeGreaterThanOrEqual(1);
  });

  it('treats a non-object value as fully spent, even against the longest offline-token budget', () => {
    expect(budgetConsumedFraction(sanitizeBudget('garbage', NOW), LONGEST_TOKEN_MS)).toBeGreaterThanOrEqual(1);
  });

  it('replaces a non-finite lastTickAt with now', () => {
    const b = { runningMsSinceHeartbeat: MINUTE, lastTickAt: Number.NaN };
    expect(sanitizeBudget(b, NOW)).toEqual({ runningMsSinceHeartbeat: MINUTE, lastTickAt: NOW });
  });
});

describe('offlineBudgetMs (which budget applies)', () => {
  const DAY = 86_400_000;
  const token = (leaseDays: number) => ({
    v: 1 as const, tenant_id: 't', tenant_slug: 's', tenant_name: 'S', terminal_id: 'x',
    plan: 'yearly' as const, status: 'active' as const, period_end: null, grace_days: 7,
    updates_until: null, max_terminals: 1, features: null,
    issued_at: new Date(0).toISOString(), lease_until: new Date(leaseDays * DAY).toISOString(),
  });

  it('is the policy budget for a terminal that can heartbeat', () => {
    expect(offlineBudgetMs(token(60), 'KEY')).toBe(BUDGET_MS);
  });

  it("is the signed lease length for an offline-token store, which can never heartbeat", () => {
    expect(offlineBudgetMs(token(365), null)).toBe(365 * DAY);
  });

  it('measures consumption against the budget it is given', () => {
    expect(budgetConsumedFraction({ runningMsSinceHeartbeat: 10 * DAY, lastTickAt: 0 }, 20 * DAY)).toBeCloseTo(0.5, 5);
  });
});

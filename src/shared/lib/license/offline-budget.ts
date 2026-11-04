/**
 * Offline runtime budget: how long the app has actually been running since it last reached the
 * licence server. Bounds offline operation even when the wall clock is frozen, because it counts
 * ticks of the app's own timer rather than trusting the clock alone. Pure functions only.
 */

import type { LicensePayload } from './types';

/** Running hours allowed without licence-server contact (policy: docs/superpowers/specs/2026-09-29-offline-licensing-policy.md). */
export const OFFLINE_BUDGET_HOURS = 720;
const OFFLINE_BUDGET_MS = OFFLINE_BUDGET_HOURS * 3_600_000;

/** Above this fraction the banner warns and a reconnected terminal must heartbeat before selling. */
export const REVALIDATE_AT_FRACTION = 0.5;

/** How often the single accrual ticker fires (useLicenseHeartbeat). */
export const OFFLINE_TICK_MS = 60_000;

export type OfflineBudget = { runningMsSinceHeartbeat: number; lastTickAt: number };

export function resetBudget(now: number): OfflineBudget {
  return { runningMsSinceHeartbeat: 0, lastTickAt: now };
}

/**
 * Credit one tick. The credit is the elapsed time, but never more than `maxTickGapMs` (a suspended
 * machine or a clock jumped forward cannot spend the budget in one go) and never less than one
 * expected tick interval (`maxTickGapMs / 2`): the tick genuinely fired, so a frozen or crawling
 * wall clock must not pause the budget — that is the whole point of this module. A clock that steps
 * backwards credits nothing; callers pass the ratcheted effective now, which never steps back, so
 * in practice a wound-back clock arrives here as a frozen one and is still credited.
 */
export function accrueRuntime(budget: OfflineBudget, now: number, maxTickGapMs: number): OfflineBudget {
  const delta = now - budget.lastTickAt;
  const credit = delta < 0 ? 0 : Math.min(Math.max(delta, maxTickGapMs / 2), maxTickGapMs);
  return { runningMsSinceHeartbeat: budget.runningMsSinceHeartbeat + credit, lastTickAt: now };
}

/** 0 = untouched, 1 = spent. Can exceed 1. */
export function budgetConsumedFraction(budget: OfflineBudget, budgetMs = OFFLINE_BUDGET_MS): number {
  return budget.runningMsSinceHeartbeat / budgetMs;
}

/**
 * The budget that applies to this terminal. One that can heartbeat (it holds a licence key) gets
 * the policy budget. A store licensed by a pasted offline token never heartbeats, so the vendor's
 * signed lease length is its offline allowance: an honest clock reaches lease_until first, and a
 * frozen clock gets exactly what the token was signed for and no more.
 */
export function offlineBudgetMs(payload: LicensePayload | null, licenseKey: string | null): number {
  if (licenseKey !== null || !payload) return OFFLINE_BUDGET_MS;
  const leaseMs = Date.parse(payload.lease_until) - Date.parse(payload.issued_at);
  return Number.isFinite(leaseMs) ? Math.max(leaseMs, 1) : OFFLINE_BUDGET_MS;
}

/**
 * Normalise a persisted budget on load. Editing local storage may only make the terminal stricter:
 * anything malformed counts as fully spent, never as zero, and a large value is kept rather than
 * clamped (clamping would hand back running time on budgets longer than the policy one). Absent
 * means a record persisted before the budget existed, which starts fresh. ponytail: a deliberate
 * edit to a well-formed small value still resets the count — the counter is local, so this bounds
 * the frozen-clock attack, not a local administrator; the signed lease_until stays the outer bound.
 */
export function sanitizeBudget(raw: unknown, now: number): OfflineBudget {
  if (raw === undefined || raw === null) return resetBudget(now);
  // Spent against any budget, including an offline token's multi-year lease.
  const spent = { runningMsSinceHeartbeat: Number.MAX_SAFE_INTEGER, lastTickAt: now };
  if (typeof raw !== 'object') return spent;
  const { runningMsSinceHeartbeat: ms, lastTickAt } = raw as Record<string, unknown>;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return spent;
  return {
    runningMsSinceHeartbeat: ms,
    lastTickAt: typeof lastTickAt === 'number' && Number.isFinite(lastTickAt) ? lastTickAt : now,
  };
}

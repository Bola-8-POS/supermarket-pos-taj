import { describe, expect, it } from 'vitest';
import { err, ok } from '@shared/lib/result';
import { classifySubmissionRecovery, SUBMISSION_RECHECK_MS, SUBMISSION_SETTLE_MS } from './submissionRecovery';

const NOW = 1_800_000_000_000;
const notCompleted = ok({ status: 'not_completed' as const });
const view = (over: Partial<Parameters<typeof classifySubmissionRecovery>[0]> = {}) =>
  classifySubmissionRecovery({
    lookup: notCompleted,
    startedAt: NOW - 1000,
    firstSeenAt: NOW,
    now: NOW,
    ...over,
  });

describe('classifySubmissionRecovery', () => {
  it('pending lookup classifies as checking', () => {
    expect(view({ lookup: 'pending' })).toEqual({ kind: 'checking' });
  });

  it('error Result classifies as unknown, never as not charged', () => {
    const lookup = err({ code: 'NETWORK_OFFLINE' as const, message: 'x' });
    expect(view({ lookup, startedAt: NOW - 10 * SUBMISSION_SETTLE_MS })).toEqual({ kind: 'unknown' });
  });

  it('completed lookup classifies as completed with the payment and tab ids', () => {
    const lookup = ok({ status: 'completed' as const, paymentId: 'p1', tabId: 't1' });
    expect(view({ lookup })).toEqual({ kind: 'completed', paymentId: 'p1', tabId: 't1' });
  });

  it('not_completed before the settle window classifies as reconciling', () => {
    expect(view({ startedAt: NOW - (SUBMISSION_SETTLE_MS - 1) })).toEqual({ kind: 'reconciling' });
  });

  it('not_completed at exactly SUBMISSION_SETTLE_MS classifies as incomplete', () => {
    expect(view({ startedAt: NOW - SUBMISSION_SETTLE_MS })).toEqual({ kind: 'incomplete' });
  });

  it('a startedAt in the future measures the window from firstSeenAt', () => {
    expect(view({ startedAt: NOW + 10 * SUBMISSION_SETTLE_MS, firstSeenAt: NOW })).toEqual({ kind: 'reconciling' });
    expect(
      view({ startedAt: NOW + 10 * SUBMISSION_SETTLE_MS, firstSeenAt: NOW, now: NOW + SUBMISSION_SETTLE_MS })
    ).toEqual({ kind: 'incomplete' });
  });

  it('a clock moved back measures the window from firstSeenAt', () => {
    // wall clock rolled back after the send: now is before startedAt
    expect(view({ startedAt: NOW + 5000, firstSeenAt: NOW, now: NOW })).toEqual({ kind: 'reconciling' });
  });

  it('SUBMISSION_SETTLE_MS equals the PROBE-confirmed value (400 s) and re-check is 5 s', () => {
    expect(SUBMISSION_SETTLE_MS).toBe(400_000);
    expect(SUBMISSION_RECHECK_MS).toBe(5000);
  });
});

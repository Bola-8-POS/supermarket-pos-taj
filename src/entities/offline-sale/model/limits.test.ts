import { describe, expect, it } from 'vitest';
import { MAX_QUEUE_ATTEMPTS } from '@shared/lib/offline-retry';
import { OFFLINE_SALE_LIMITS, checkOfflineSaleLimits } from './limits';
import { makeHeavySale, makeSale, STORAGE_QUOTA_CHARS } from './offline-sale.fixtures';
import { useOfflineSaleStore } from './store';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR = 3_600_000;
const soldAt = (ms: number) => makeSale({ soldAt: new Date(ms).toISOString() });

describe('offline sale limits', () => {
  it('uses the shared attempt budget, not a second literal', () => {
    expect(OFFLINE_SALE_LIMITS.maxAttempts).toBe(MAX_QUEUE_ATTEMPTS);
    expect(OFFLINE_SALE_LIMITS.maxNonTerminal).toBe(500);
    expect(OFFLINE_SALE_LIMITS.maxOldestAgeMs).toBe(24 * HOUR);
    expect(OFFLINE_SALE_LIMITS.confirmedRetentionMs).toBe(48 * HOUR);
  });

  it('limits block at 500 and at 24 hours', () => {
    const recent = Array.from({ length: 499 }, () => soldAt(NOW - HOUR));
    expect(checkOfflineSaleLimits(recent, NOW)).toEqual({ ok: true });
    expect(checkOfflineSaleLimits([...recent, soldAt(NOW - HOUR)], NOW)).toEqual({
      ok: false,
      reason: 'count',
    });
    expect(checkOfflineSaleLimits([soldAt(NOW - 24 * HOUR + 1)], NOW)).toEqual({ ok: true });
    expect(checkOfflineSaleLimits([soldAt(NOW - 24 * HOUR)], NOW)).toEqual({
      ok: false,
      reason: 'age',
    });
  });

  it('ignores confirmed and resolved records', () => {
    const old = new Date(NOW - 40 * HOUR).toISOString();
    const done = Array.from({ length: 400 }, () => makeSale({ status: 'confirmed', soldAt: old }));
    expect(checkOfflineSaleLimits(done, NOW)).toEqual({ ok: true });
  });
});

describe('offline sale storage budget', () => {
  it('500 records fit in the persisted store', () => {
    const records = Array.from({ length: 500 }, (_, n) => makeHeavySale(n, NOW - n * 1000));

    useOfflineSaleStore.setState({ records });
    // The quota is Chromium's per origin: 5,242,880 UTF-16 code units counting key + value. Only the
    // 500 NON-TERMINAL records are in the picture on purpose: confirmed / resolved ones give way to
    // them under pressure (store.pressure.test.ts), so the worst mix is 500 heavy records that all
    // carry the full re-ring key list. 1 MiB is left for the origin's other keys.
    const used = 'offline-sales'.length + (localStorage.getItem('offline-sales') ?? '').length;

    expect(records).toHaveLength(500);
    expect(OFFLINE_SALE_LIMITS.maxNonTerminal).toBeLessThanOrEqual(records.length);
    expect(used, `measured ${String(used)} chars`).toBeLessThan(STORAGE_QUOTA_CHARS - 1024 * 1024);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_BACKOFF_MS,
  MAX_QUEUE_ATTEMPTS,
  UNREACHABLE_RETRY_MS,
  computeBackoffMs,
} from './offline-retry';

describe('offline-retry', () => {
  it('keeps the queue constants', () => {
    expect(MAX_QUEUE_ATTEMPTS).toBe(5);
    expect(UNREACHABLE_RETRY_MS).toBe(30_000);
    expect(MAX_BACKOFF_MS).toBe(300_000);
  });

  it('computeBackoffMs is 2^retryCount seconds', () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(5)).toBe(32_000);
  });

  it('computeBackoffMs caps at five minutes', () => {
    expect(computeBackoffMs(8)).toBe(256_000);
    expect(computeBackoffMs(9)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffMs(40)).toBe(MAX_BACKOFF_MS);
  });
});

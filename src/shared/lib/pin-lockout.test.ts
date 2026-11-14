import { describe, it, expect } from 'vitest';

import { PIN_LOCKOUT, nextRetryAfterMs, isIdleReset } from './pin-lockout';

describe('pin lockout schedule', () => {
  it('allows the first four attempts with no delay', () => {
    for (let n = 0; n <= PIN_LOCKOUT.freeAttempts; n += 1) {
      expect(nextRetryAfterMs(n)).toBe(0);
    }
  });

  it('doubles from the base delay after the free attempts', () => {
    expect(nextRetryAfterMs(5)).toBe(30_000);
    expect(nextRetryAfterMs(6)).toBe(60_000);
    expect(nextRetryAfterMs(7)).toBe(120_000);
  });

  it('caps at the maximum delay', () => {
    expect(nextRetryAfterMs(20)).toBe(PIN_LOCKOUT.maxDelayMs);
  });

  it('resets after the idle window', () => {
    const now = 10_000_000;
    expect(isIdleReset(now - PIN_LOCKOUT.idleResetMs - 1, now)).toBe(true);
    expect(isIdleReset(now - 1000, now)).toBe(false);
  });
});

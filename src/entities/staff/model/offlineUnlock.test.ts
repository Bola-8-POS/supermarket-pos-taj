import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOfflineUnlock, clearOfflineUnlock, rememberOfflineUnlock } from './offlineUnlock';

function randomPin(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

describe('offlineUnlock', () => {
  const pin = randomPin();
  const other = pin === '999999' ? '999998' : String(Number(pin) + 1).padStart(6, '0');

  beforeEach(() => {
    clearOfflineUnlock();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts only the remembered staff member with the remembered PIN', async () => {
    await rememberOfflineUnlock('staff-a', pin);
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: true });
    expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 0 });
    expect(await checkOfflineUnlock('staff-b', pin)).toEqual({ ok: false, retryAfter: 0 });
  });

  it('accepts nothing before remember and after clear', async () => {
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: false, retryAfter: 0 });
    await rememberOfflineUnlock('staff-a', pin);
    clearOfflineUnlock();
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: false, retryAfter: 0 });
  });

  it('locks for 30 s on the fifth wrong attempt, doubles per further attempt, and refuses the right PIN while locked', async () => {
    await rememberOfflineUnlock('staff-a', pin);
    for (let i = 0; i < 4; i++) {
      expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 0 });
    }
    expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 30 });
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: false, retryAfter: 30 });
    vi.advanceTimersByTime(30_000);
    expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 60 });
    vi.advanceTimersByTime(60_000);
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: true });
    expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 0 });
  });

  it('caps the lock at 15 minutes and starts over after 30 minutes without an attempt', async () => {
    await rememberOfflineUnlock('staff-a', pin);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await checkOfflineUnlock('staff-a', other);
      if (!res.ok) last = res.retryAfter;
      vi.advanceTimersByTime(last * 1000);
    }
    expect(last).toBe(900);
    vi.advanceTimersByTime(30 * 60_000);
    expect(await checkOfflineUnlock('staff-a', other)).toEqual({ ok: false, retryAfter: 0 });
  });

  it('starts a fresh counter on remember', async () => {
    await rememberOfflineUnlock('staff-a', pin);
    for (let i = 0; i < 5; i++) await checkOfflineUnlock('staff-a', other);
    await rememberOfflineUnlock('staff-a', pin);
    expect(await checkOfflineUnlock('staff-a', pin)).toEqual({ ok: true });
  });
});

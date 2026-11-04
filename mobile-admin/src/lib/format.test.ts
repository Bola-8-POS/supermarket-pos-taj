import { daysUntil, elapsed, initials, money, rangeFor, startOfDay } from './format';

describe('format', () => {
  it('money formats MXN', () => {
    expect(money(1234.5).replace(/\s/g, '')).toMatch(/\$1,234\.50/);
    expect(money(null).replace(/\s/g, '')).toMatch(/\$0\.00/);
  });

  it('elapsed renders h/m', () => {
    const t0 = new Date('2026-09-06T08:00:00');
    expect(elapsed(t0, new Date('2026-09-06T10:15:00'))).toBe('2h 15m');
    expect(elapsed(t0, new Date('2026-09-06T08:05:00'))).toBe('5m');
    expect(elapsed(t0, new Date('2026-09-06T07:00:00'))).toBe('0m');
  });

  it('rangeFor covers the expected windows', () => {
    const now = new Date('2026-09-06T15:30:00');
    const today = startOfDay(now);
    expect(rangeFor('today', now)).toEqual({ from: today, to: now });
    expect(rangeFor('yesterday', now).to).toEqual(today);
    expect(rangeFor('7d', now).from.getDate()).toBe(new Date('2026-08-31T00:00:00').getDate());
    expect(rangeFor('30d', now).from.getTime()).toBe(today.getTime() - 29 * 86_400_000);
  });

  it('daysUntil is whole days from local midnight', () => {
    const tomorrow = new Date(startOfDay(new Date()).getTime() + 86_400_000);
    expect(daysUntil(tomorrow.toISOString().slice(0, 10))).toBeGreaterThanOrEqual(0);
  });

  it('initials', () => {
    expect(initials('Ana María López')).toBe('AM');
    expect(initials('girish')).toBe('G');
  });
});

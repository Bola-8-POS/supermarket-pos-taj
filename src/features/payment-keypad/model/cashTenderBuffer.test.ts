import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  cashTenderCents,
  cashTenderFromCents,
  MAX_CENTS,
  reduceCashTender,
  type CashTenderAction,
  type CashTenderState,
} from './cashTenderBuffer';

const EMPTY: CashTenderState = { text: '', armed: false };

const d = (digit: number): CashTenderAction => ({ type: 'digit', digit });
const DOT: CashTenderAction = { type: 'decimal' };
const BACK: CashTenderAction = { type: 'backspace' };
const CLEAR: CashTenderAction = { type: 'clear' };

function run(actions: CashTenderAction[], from: CashTenderState = EMPTY): CashTenderState {
  return actions.reduce(reduceCashTender, from);
}

const actionArb: fc.Arbitrary<CashTenderAction> = fc.oneof(
  fc.integer({ min: 0, max: 9 }).map(digit => d(digit)),
  fc.constant(DOT),
  fc.constant(BACK),
  fc.constant(CLEAR),
  fc.integer({ min: 0, max: MAX_CENTS + 500 }).map(cents => ({ type: 'preset', cents }) as CashTenderAction)
);

describe('cashTenderBuffer', () => {
  test('1, 0, 0 gives 10000 cents', () => {
    expect(cashTenderCents(run([d(1), d(0), d(0)]))).toBe(10000);
  });

  test('decimal starts cents: 1, ., 5 gives 150 cents', () => {
    expect(cashTenderCents(run([d(1), DOT, d(5)]))).toBe(150);
  });

  test('a second separator is ignored', () => {
    const s = run([d(1), DOT, d(5)]);
    expect(run([DOT], s)).toEqual(s);
  });

  test('a third fraction digit is ignored', () => {
    const s = run([d(1), DOT, d(2), d(5)]);
    expect(run([d(9)], s)).toEqual(s);
    expect(cashTenderCents(s)).toBe(125);
  });

  test('MAX_CENTS is reachable and one more digit past it leaves the state unchanged', () => {
    const s = cashTenderFromCents(MAX_CENTS);
    expect(cashTenderCents(s)).toBe(MAX_CENTS);
    expect(run([d(9)], s)).toEqual(s);
    const nearMax = run([d(9), d(9), d(9), d(9), d(9), d(9), d(9), d(9), DOT, d(9), d(9)]);
    expect(cashTenderCents(nearMax)).toBe(MAX_CENTS);
    expect(run([d(1)], run([d(9), d(9), d(9), d(9), d(9), d(9), d(9), d(9), d(9)]))).toEqual(
      run([d(9), d(9), d(9), d(9), d(9), d(9), d(9), d(9), d(9)])
    );
  });

  test('clear, empty and backspace on empty give 0 cents', () => {
    expect(cashTenderCents(EMPTY)).toBe(0);
    expect(cashTenderCents(run([BACK]))).toBe(0);
    expect(cashTenderCents(run([d(4), d(2), CLEAR]))).toBe(0);
    expect(run([d(0)]).text).toBe('');
    expect(cashTenderCents(run([d(7), BACK, BACK]))).toBe(0);
  });

  test('leading zeros collapse: 0, 0, 5 gives 500 cents', () => {
    expect(cashTenderCents(run([d(0), d(0), d(5)]))).toBe(500);
    expect(run([d(0), d(0), d(5)]).text).toBe('5');
  });

  test('preset arms; next digit replaces; later digits append', () => {
    const armed = reduceCashTender(EMPTY, { type: 'preset', cents: 50000 });
    expect(armed.armed).toBe(true);
    expect(cashTenderCents(armed)).toBe(50000);
    const next = run([d(7)], armed);
    expect(cashTenderCents(next)).toBe(700);
    expect(next.armed).toBe(false);
    expect(cashTenderCents(run([d(7), d(5)], armed))).toBe(7500);
  });

  test('decimal, backspace and clear edit an armed preset', () => {
    const armed = reduceCashTender(EMPTY, { type: 'preset', cents: 20000 });
    expect(run([DOT], armed)).toEqual({ text: '200.', armed: false });
    expect(run([BACK], armed)).toEqual({ text: '20', armed: false });
    expect(run([CLEAR], armed)).toEqual({ text: '', armed: false });
  });

  test('canonical text always uses "."', () => {
    expect(run([d(1), DOT, d(5)]).text).toBe('1.5');
    expect(run([DOT, d(5)]).text).toBe('0.5');
    expect(cashTenderFromCents(1250).text).toBe('12.5');
    expect(cashTenderFromCents(1255).text).toBe('12.55');
    expect(cashTenderFromCents(10000).text).toBe('100');
    expect(cashTenderFromCents(5).text).toBe('0.05');
  });

  test('cashTenderFromCents round-trips every cents value in [0, MAX_CENTS]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_CENTS }), cents => {
        const s = cashTenderFromCents(cents);
        expect(s.armed).toBe(false);
        expect(cashTenderCents(s)).toBe(cents);
      })
    );
  });

  test('for any action sequence, cents is an integer in [0, MAX_CENTS]', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), actions => {
        const cents = cashTenderCents(run(actions));
        expect(Number.isInteger(cents)).toBe(true);
        expect(cents).toBeGreaterThanOrEqual(0);
        expect(cents).toBeLessThanOrEqual(MAX_CENTS);
      })
    );
  });

  test('for any digit/decimal sequence, cents equals the integer value of the canonical text', () => {
    const keyArb = fc.oneof(fc.integer({ min: 0, max: 9 }).map(digit => d(digit)), fc.constant(DOT));
    fc.assert(
      fc.property(fc.array(keyArb, { maxLength: 30 }), actions => {
        const s = run(actions);
        const [whole = '', frac = ''] = s.text.split('.');
        expect(s.text).toMatch(/^(\d*)(\.\d{0,2})?$/);
        expect(cashTenderCents(s)).toBe(Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0'));
      })
    );
  });
});

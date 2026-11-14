/**
 * Whole-peso cash tender buffer (D-17, D-18): pure integer-cents state machine.
 * Digits append to the whole part ("1","0","0" = 100.00); the decimal key starts cents.
 * `text` is canonical ('.', at most 2 fraction digits, no leading zeros, '' = 0).
 */

/** Caps the amount at 999,999.99: plenty for a single register tender, well short of overflow. */
export const MAX_CENTS = 99_999_999;

export interface CashTenderState {
  text: string;
  /** True right after a preset: the next digit replaces the amount instead of appending. */
  armed: boolean;
}

export type CashTenderAction =
  | { type: 'digit'; digit: number }
  | { type: 'decimal' }
  | { type: 'backspace' }
  | { type: 'clear' }
  | { type: 'preset'; cents: number };

const WHOLE_MAX_LEN = String(Math.floor(MAX_CENTS / 100)).length;

/** Integer arithmetic over digit strings; the whole part is length-guarded before Number(). */
function centsOfText(text: string): number {
  const [whole = '', frac = ''] = text.split('.');
  if (whole.length > WHOLE_MAX_LEN) return Number.POSITIVE_INFINITY;
  return Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0');
}

export function cashTenderCents(state: CashTenderState): number {
  return centsOfText(state.text);
}

export function cashTenderFromCents(cents: number): CashTenderState {
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_CENTS) return { text: '', armed: false };
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return { text: String(whole), armed: false };
  const fracText = frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0');
  return { text: `${String(whole)}.${fracText}`, armed: false };
}

function editText(text: string, action: CashTenderAction): string {
  switch (action.type) {
    case 'digit': {
      const dot = text.indexOf('.');
      if (dot !== -1) return text.length - dot > 2 ? text : text + String(action.digit);
      if (text === '' && action.digit === 0) return '';
      return text + String(action.digit);
    }
    case 'decimal':
      return text.includes('.') ? text : `${text || '0'}.`;
    case 'backspace': {
      const next = text.slice(0, -1);
      return next === '0' ? '' : next;
    }
    case 'clear':
    case 'preset':
      return '';
  }
}

export function reduceCashTender(state: CashTenderState, action: CashTenderAction): CashTenderState {
  if (action.type === 'preset') {
    const next = cashTenderFromCents(action.cents);
    return action.cents > MAX_CENTS || !Number.isInteger(action.cents) ? state : { ...next, armed: true };
  }
  const base = state.armed && action.type === 'digit' ? '' : state.text;
  const text = editText(base, action);
  if (centsOfText(text) > MAX_CENTS) return state;
  return { text, armed: false };
}

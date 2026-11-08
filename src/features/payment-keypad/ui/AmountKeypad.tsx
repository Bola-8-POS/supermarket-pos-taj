/**
 * AmountKeypad — tap-only numeric keypad for entering a money amount on the
 * Payment page (cash tendered, card charge override, split-row amounts).
 *
 * Fully controlled: takes the current dollar `value` and calls `onChange`
 * with the next dollar value, digit-shift style (like a physical calculator
 * or cash register) — pressing a digit appends it as the new rightmost cent,
 * backspace drops the rightmost cent. No internal buffer state, so it never
 * drifts out of sync with the MoneyInput/quick-tender buttons it sits next
 * to — they all read/write the same `value`.
 *
 * Deliberately no keyboard-event wiring, matching the cart-screen keypad
 * this replaced (Task 6, src/features/checkout-keypad, removed): every key
 * here is a plain tap (POSButton onClick), nothing more.
 */
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import { POSButton } from '@shared/ui/POSButton';

export interface AmountKeypadProps {
  /** Current amount in dollars (e.g., 12.50) */
  value: number;
  /** Called with the next dollar amount after a digit/backspace/clear tap */
  onChange: (value: number) => void;
  disabled: boolean;
}

/** Caps the amount at $999,999.99 — plenty for a single register tender, well short of overflow. */
const MAX_CENTS = 99_999_999;

const DIGITS_1_TO_9 = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

function toCents(value: number): number {
  return Math.round(value * 100);
}

export function AmountKeypad({ value, onChange, disabled }: AmountKeypadProps) {
  const { t } = useTranslation('wPanels');

  const pressDigit = (digit: string) => {
    const nextCents = toCents(value) * 10 + Number(digit);
    if (nextCents > MAX_CENTS) return;
    onChange(nextCents / 100);
  };
  const backspace = () => {
    onChange(Math.floor(toCents(value) / 10) / 100);
  };
  const clear = () => {
    onChange(0);
  };

  return (
    <section
      aria-label={t('paymentForm.amountKeypad.title')}
      data-testid="amount-keypad"
      className="flex w-52 flex-col gap-2 rounded-xl border border-border bg-card p-3"
    >
      <output
        data-testid="amount-keypad-display"
        aria-live="polite"
        className="rounded-lg bg-muted px-3 py-2 text-right font-mono text-2xl tabular-nums"
      >
        {formatMoney(value)}
      </output>

      <div className="grid grid-cols-3 gap-2">
        {DIGITS_1_TO_9.map(d => (
          <POSButton
            key={d}
            type="button"
            variant="outline"
            touchSize="large"
            disabled={disabled}
            onClick={() => {
              pressDigit(d);
            }}
          >
            {d}
          </POSButton>
        ))}
        <POSButton
          type="button"
          variant="outline"
          touchSize="large"
          disabled={disabled}
          aria-label={t('paymentForm.amountKeypad.clear')}
          onClick={clear}
        >
          {/* eslint-disable i18next/no-literal-string -- single-char glyph; aria-label carries the translated word */}
          C
          {/* eslint-enable i18next/no-literal-string */}
        </POSButton>
        <POSButton
          type="button"
          variant="outline"
          touchSize="large"
          disabled={disabled}
          onClick={() => {
            pressDigit('0');
          }}
        >
          0
        </POSButton>
        <POSButton
          type="button"
          variant="outline"
          touchSize="large"
          disabled={disabled}
          aria-label={t('paymentForm.amountKeypad.backspace')}
          onClick={backspace}
        >
          {/* eslint-disable i18next/no-literal-string -- single-char glyph; aria-label carries the translated word */}
          ⌫
          {/* eslint-enable i18next/no-literal-string */}
        </POSButton>
      </div>
    </section>
  );
}

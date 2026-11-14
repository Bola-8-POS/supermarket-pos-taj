/**
 * CashTenderInput: the main cash-tendered field plus its on-screen keypad (D-17..D-20).
 *
 * Fully controlled by the cashTenderBuffer reducer. Free text (fill, paste) is replayed key by key
 * through the reducer, so it is capped and sanitised like typed keys and never stored as typed. The hardware keyboard and the key buttons both dispatch the same
 * actions, so they always yield identical state. One composite keydown handler lives on the
 * group root; there is deliberately no window/document listener.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import { cn } from '@shared/lib/utils';
import { POSButton } from '@shared/ui/POSButton';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { cashTenderCents, type CashTenderAction, type CashTenderState } from '../model/cashTenderBuffer';

export interface CashTenderInputProps {
  id: string;
  label: string;
  state: CashTenderState;
  onAction: (action: CashTenderAction) => void;
  disabled: boolean;
  keypadVisible: boolean;
}

/** Raw editable value, never locale-grouped or symbol-prefixed (a symbol would corrupt the amount, T-28-06). */
function displayValue(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${String(whole)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Maps a keydown to a buffer action; null = not a tender key. */
function actionForKey(e: KeyboardEvent): CashTenderAction | null {
  if (/^[0-9]$/.test(e.key)) return { type: 'digit', digit: Number(e.key) };
  if (e.key === 'Delete') return { type: 'clear' };
  if (e.key === 'Backspace') return { type: 'backspace' };
  if (e.key === '.' || e.key === ',' || e.code === 'NumpadDecimal') return { type: 'decimal' };
  return null;
}

const DIGITS_GRID = [7, 8, 9, 4, 5, 6, 1, 2, 3] as const;

function KeyButton({
  disabled,
  label,
  className,
  onPress,
  children,
}: {
  disabled: boolean;
  label?: string;
  className?: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <POSButton
      type="button"
      variant="outline"
      touchSize="large"
      disabled={disabled}
      {...(label ? { 'aria-label': label } : {})}
      className={cn('min-h-[56px] min-w-[56px]', className)}
      onMouseDown={e => {
        // keep focus on the input so hardware keys keep working after a tap
        e.preventDefault();
      }}
      onClick={onPress}
    >
      {children}
    </POSButton>
  );
}

export function CashTenderInput({ id, label, state, onAction, disabled, keypadVisible }: CashTenderInputProps) {
  const { t } = useTranslation('wPanels');
  const symbol = formatMoney(0).replace(/[0-9.,\s]/g, '');

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = e.target instanceof HTMLButtonElement;
    // Enter on a key button activates that button; everywhere else it must never submit the payment.
    if (e.key === 'Enter' && !onButton) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = actionForKey(e);
    if (!action) return;
    e.preventDefault();
    if (!disabled) onAction(action);
  };

  /** Fill, paste and IME land here: the text is replayed through the reducer, never stored as typed. */
  const replayText = (text: string) => {
    if (disabled) return;
    press({ type: 'clear' });
    for (const ch of text) {
      if (ch >= '0' && ch <= '9') press({ type: 'digit', digit: Number(ch) });
      else if (ch === '.') press({ type: 'decimal' });
    }
  };

  const press = (action: CashTenderAction) => {
    if (!disabled) onAction(action);
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role="group" composite root; keydown is delegated from the input and the keys
    <div role="group" aria-label={t('paymentForm.amountKeypad.group')} onKeyDown={handleKeyDown} className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
          {symbol}
        </span>
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={displayValue(cashTenderCents(state))}
          onChange={e => {
            replayText(e.target.value);
          }}
          onPaste={e => {
            // a paste REPLACES the tender: the browser would merge it into the displayed "0.00" at the caret
            e.preventDefault();
            // eslint-disable-next-line i18next/no-literal-string -- DataTransfer format, not UI copy
            replayText(e.clipboardData.getData('text'));
          }}
          disabled={disabled}
          className="pl-12 text-numeric font-medium"
        />
      </div>
      {keypadVisible && (
        <div
          data-testid="amount-keypad"
          className="grid w-full max-w-xs grid-cols-4 gap-2 rounded-xl border border-border bg-card p-3"
        >
          {DIGITS_GRID.map(digit => (
            <KeyButton
              key={digit}
              disabled={disabled}
              label={t('paymentForm.amountKeypad.key', { digit })}
              onPress={() => {
                press({ type: 'digit', digit });
              }}
            >
              {digit}
            </KeyButton>
          ))}
          <KeyButton
            disabled={disabled}
            onPress={() => {
              press({ type: 'clear' });
            }}
          >
            {t('paymentForm.amountKeypad.clear')}
          </KeyButton>
          <KeyButton
            disabled={disabled}
            label={t('paymentForm.amountKeypad.key', { digit: 0 })}
            onPress={() => {
              press({ type: 'digit', digit: 0 });
            }}
          >
            0
          </KeyButton>
          <KeyButton
            disabled={disabled}
            label={t('paymentForm.amountKeypad.decimal')}
            onPress={() => {
              press({ type: 'decimal' });
            }}
          >
            {/* eslint-disable-next-line i18next/no-literal-string -- single-char glyph; aria-label carries the translated word */}
            {'.'}
          </KeyButton>
          <KeyButton
            disabled={disabled}
            label={t('paymentForm.amountKeypad.backspace')}
            className="col-start-4 row-span-4 row-start-1 h-full"
            onPress={() => {
              press({ type: 'backspace' });
            }}
          >
            {/* eslint-disable-next-line i18next/no-literal-string -- single-char glyph; aria-label carries the translated word */}
            {'⌫'}
          </KeyButton>
        </div>
      )}
    </div>
  );
}

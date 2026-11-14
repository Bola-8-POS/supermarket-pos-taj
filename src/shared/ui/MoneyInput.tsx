/**
 * MONEY INPUT COMPONENT
 *
 * Currency input that stores values as integer cents to avoid floating point issues.
 * Always displays formatted with 2 decimal places.
 */

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/utils';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';

export type MoneyInputProps = {
  /** Value in dollars (e.g., 12.50) */
  value: number;
  /** Callback when value changes */
  onChange: (value: number) => void;
  /** Called after blur once the value is normalized (optional) */
  onBlurCommit?: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Input label */
  label?: string;
  /** Accessible name when no visible label is rendered (e.g. table-style line editors) */
  ariaLabel?: string;
  /** Disable input */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Test hook forwarded to the underlying <input> (e.g. for a value shared across multiple possible input types). */
  'data-testid'?: string;
};

/**
 * Formats cents to dollar string (e.g., 1250 â†’ "12.50")
 */
function formatCents(cents: number): string {
  // eslint-disable-next-line no-restricted-syntax -- editable input's raw value (re-typed/re-parsed by parseToCents above), not a money display; a currency symbol here would corrupt the amount (T-28-06)
  return (cents / 100).toFixed(2);
}

/**
 * Parses dollar string to cents (e.g., "12.50" â†’ 1250)
 */
function parseToCents(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

/**
 * Money input with automatic formatting and cent-based storage.
 *
 * @example
 * ```tsx
 * <MoneyInput
 *   value={amount}
 *   onChange={setAmount}
 *   label="Amount"
 *   placeholder="0.00"
 * />
 * ```
 */
export function MoneyInput({
  value,
  onChange,
  onBlurCommit,
  placeholder = '0.00',
  label,
  ariaLabel,
  disabled = false,
  className,
  'data-testid': dataTestId,
}: MoneyInputProps) {
  const { t } = useTranslation('common');
  const inputId = useId();
  const [displayValue, setDisplayValue] = useState(() => {
    const cents = Math.round(value * 100);
    return formatCents(cents);
  });
  const [isFocused, setIsFocused] = useState(false);

  // Update display value when prop value changes (only when not focused)
  useEffect(() => {
    if (!isFocused) {
      const cents = Math.round(value * 100);
      const formatted = formatCents(cents);
      // Only update if different to avoid unnecessary renders
      setDisplayValue(prev => (prev !== formatted ? formatted : prev));
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    setDisplayValue(input);

    // Parse and update value
    const cents = parseToCents(input);
    onChange(cents / 100);
  };

  const handleFocus = () => {
    setIsFocused(true);
  };

  const handleBlur = () => {
    setIsFocused(false);

    // Format to 2 decimal places on blur
    const cents = parseToCents(displayValue);
    setDisplayValue(formatCents(cents));
    onChange(cents / 100);
    onBlurCommit?.();
  };

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <Label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </Label>
      )}
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
          $
        </span>
        <Input
          id={inputId}
          type="text"
          inputMode="decimal"
          value={displayValue}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={disabled}
          className="pl-8 text-numeric font-medium"
          {...(!label ? { 'aria-label': ariaLabel ?? t('moneyInput.amountAria') } : {})}
          {...(dataTestId ? { 'data-testid': dataTestId } : {})}
        />
      </div>
    </div>
  );
}

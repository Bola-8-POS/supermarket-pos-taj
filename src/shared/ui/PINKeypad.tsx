/**
 * PIN KEYPAD COMPONENT
 *
 * 10-key numeric keypad for PIN entry. Large touch targets, value shown as
 * dots for security.
 */

import { Delete, Loader2 } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@shared/lib/utils';

import { Button } from './button';

export interface PINKeypadProps {
  /** Current PIN value */
  value: string;
  /** Called when PIN value changes */
  onChange: (value: string) => void;
  /** Maximum PIN length (default: 6) */
  maxLength?: number;
  /** Called when PIN reaches maxLength */
  onComplete?: (pin: string) => void;
  /** Label text above keypad */
  label?: string;
  /** Error message to display */
  error?: string;
  /** Loading state - disables all keys */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/* eslint-disable i18next/no-literal-string -- Tailwind class string, not UI copy */
const KEY_CLASS =
  'h-16 w-full rounded-xl border-border bg-card text-2xl font-medium tabular-nums shadow-xs hover:bg-muted hover:border-border-strong active:scale-[0.97] dark:bg-input/20';
/* eslint-enable i18next/no-literal-string */

export function PINKeypad({
  value,
  onChange,
  maxLength = 6,
  onComplete,
  label,
  error,
  isLoading = false,
  className,
}: PINKeypadProps) {
  const { t } = useTranslation('common');
  const handleKeyPress = React.useCallback(
    (digit: string) => {
      if (isLoading || value.length >= maxLength) return;

      const newValue = value + digit;
      onChange(newValue);

      if (newValue.length === maxLength && onComplete) {
        onComplete(newValue);
      }
    },
    [value, maxLength, onChange, onComplete, isLoading]
  );

  const handleBackspace = React.useCallback(() => {
    if (isLoading || value.length === 0) return;
    onChange(value.slice(0, -1));
  }, [value, onChange, isLoading]);

  // Keyboard support
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading) return;

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyPress, handleBackspace, isLoading]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {label && (
        <label className="text-center text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {label}
        </label>
      )}

      {/* PIN Display */}
      <div
        className={cn(
          'flex h-14 items-center justify-center gap-3 rounded-xl border bg-muted/50 px-4 transition-colors',
          error ? 'border-destructive/60 bg-destructive-soft' : 'border-border',
          isLoading && 'opacity-60'
        )}
        aria-label={t('pinKeypad.display')}
        aria-live="polite"
      >
        {isLoading ? (
          <Loader2 className="size-5 animate-spin text-brand" />
        ) : (
          <>
            {Array.from({ length: maxLength }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  'block size-3 shrink-0 rounded-full transition-[background-color,transform] duration-150',
                  i < value.length
                    ? 'scale-100 bg-foreground'
                    : 'scale-90 bg-transparent ring-1 ring-muted-foreground/40 ring-inset'
                )}
                aria-hidden="true"
              />
            ))}
          </>
        )}
      </div>

      {error && (
        <p className="-mt-1 text-center text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* Keypad Grid */}
      <div className="grid grid-cols-3 gap-2.5" role="group" aria-label={t('pinKeypad.keypad')}>
        {keys.slice(0, 9).map(key => (
          <Button
            key={key}
            variant="outline"
            size="lg"
            className={KEY_CLASS}
            onClick={() => {
              handleKeyPress(key);
            }}
            disabled={isLoading || value.length >= maxLength}
            aria-label={`Key ${key}`}
          >
            {key}
          </Button>
        ))}

        <div />
        <Button
          variant="outline"
          size="lg"
          className={KEY_CLASS}
          onClick={() => {
            handleKeyPress('0');
          }}
          disabled={isLoading || value.length >= maxLength}
          aria-label={t('pinKeypad.key0')}
        >
          0
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="h-16 w-full rounded-xl text-muted-foreground hover:text-foreground active:scale-[0.97]"
          onClick={() => {
            handleBackspace();
          }}
          disabled={isLoading || value.length === 0}
          aria-label={t('pinKeypad.backspace')}
        >
          <Delete className="size-6" />
        </Button>
      </div>
    </div>
  );
}

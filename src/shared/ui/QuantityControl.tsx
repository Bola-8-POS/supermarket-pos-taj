/**
 * QUANTITY CONTROL COMPONENT
 *
 * Three-part stepper (−, value, +) rendered as one pill with large touch
 * targets. Includes haptic feedback on devices that support it.
 */

import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/utils';
import { Button } from '@shared/ui/button';

export type QuantityControlProps = {
  /** Current quantity value */
  value: number;
  /** Minimum allowed value */
  min?: number;
  /** Maximum allowed value */
  max?: number;
  /** Callback when value changes */
  onChange: (value: number) => void;
  /** Disable all controls */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
};

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10);
  }
}

export function QuantityControl({
  value,
  min = 1,
  max = 99,
  onChange,
  disabled = false,
  className,
}: QuantityControlProps) {
  const { t } = useTranslation('common');
  const canDecrement = value > min;
  const canIncrement = value < max;

  const handleDecrement = () => {
    if (canDecrement && !disabled) {
      triggerHaptic();
      onChange(value - 1);
    }
  };

  const handleIncrement = () => {
    if (canIncrement && !disabled) {
      triggerHaptic();
      onChange(value + 1);
    }
  };

  return (
    <div
      className={cn(
        'inline-flex h-11 items-center rounded-lg border border-border bg-card shadow-xs dark:bg-input/20',
        className
      )}
      role="group"
      aria-label={t('quantityControl.group')}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleDecrement}
        disabled={disabled || !canDecrement}
        aria-label={t('quantityControl.decrease')}
        className="size-11 touch-manipulation rounded-l-lg rounded-r-none"
      >
        <Minus className="size-4" />
      </Button>

      <div
        className="text-numeric flex h-full w-12 items-center justify-center border-x border-border text-base font-semibold"
        aria-live="polite"
        aria-atomic="true"
      >
        {value}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleIncrement}
        disabled={disabled || !canIncrement}
        aria-label={t('quantityControl.increase')}
        className="size-11 touch-manipulation rounded-l-none rounded-r-lg"
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
}

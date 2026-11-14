/**
 * MONEY DISPLAY COMPONENT
 *
 * Displays formatted money amounts with proper styling.
 * Uses @shared/lib/format.formatMoney() for consistent, locale-aware formatting.
 */

import { useTranslation } from 'react-i18next';
import { formatMoney } from '@shared/lib/format';
import { cn } from '@shared/lib/utils';

export type MoneyDisplayProps = {
  /** Amount in dollars (e.g., 12.50) */
  amount: number;
  /** Force negative styling even if amount is positive */
  negative?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Additional CSS classes */
  className?: string;
};

/* eslint-disable i18next/no-literal-string -- Tailwind class-name lookup table, not UI copy */
const sizeClasses = {
  sm: 'text-sm font-medium',
  md: 'text-base font-medium',
  lg: 'text-xl font-semibold',
  xl: 'text-3xl font-bold tracking-tight',
};
/* eslint-enable i18next/no-literal-string */

/**
 * Displays a formatted money amount.
 *
 * @example
 * ```tsx
 * <MoneyDisplay amount={12.50} />
 * <MoneyDisplay amount={-5.00} />
 * <MoneyDisplay amount={100.00} size="xl" />
 * ```
 */
export function MoneyDisplay({
  amount,
  negative = false,
  size = 'md',
  className,
}: MoneyDisplayProps) {
  const { t } = useTranslation('common');
  const isNegative = amount < 0 || negative;
  const formatted = formatMoney(Math.abs(amount));

  return (
    <span
      className={cn(
        'text-numeric whitespace-nowrap',
        sizeClasses[size],
        isNegative && 'text-destructive',
        className
      )}
      aria-label={`${isNegative ? t('moneyDisplay.negativePrefix') : ''}${formatted} dollars`}
    >
      {isNegative && '−'}
      {formatted}
    </span>
  );
}

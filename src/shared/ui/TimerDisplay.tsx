/**
 * TIMER DISPLAY COMPONENT
 *
 * Displays elapsed time in mm:ss or h:mm:ss format.
 * Uses domain-helpers.formatElapsed() for consistent formatting.
 */

import { formatElapsed, formatTimeOpen } from '@shared/lib/domain-helpers';
import { cn } from '@shared/lib/utils';

export type TimerDisplayProps = {
  /** How to render time: clock-style elapsed, or human tab-open duration (e.g. 2h 15m) */
  mode?: 'elapsed' | 'tabOpen';
  /** Tab opened at — required when mode is tabOpen */
  openedAt?: Date;
  /** Reference time for tabOpen mode (defaults to now; use in tests) */
  now?: Date;
  /** Total elapsed seconds — used when mode is elapsed (default) */
  totalSeconds?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show warning styling (e.g., session approaching 3 hours) */
  warning?: boolean;
  /** Critical styling (e.g. tab open 4h+) */
  critical?: boolean;
  /** Additional CSS classes */
  className?: string;
};

/* eslint-disable i18next/no-literal-string -- Tailwind class-name lookup table, not UI copy */
const sizeClasses = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-2xl font-semibold',
};
/* eslint-enable i18next/no-literal-string */

/**
 * Displays elapsed time with optional warning styling.
 *
 * @example
 * ```tsx
 * <TimerDisplay totalSeconds={90} />
 * <TimerDisplay totalSeconds={3661} size="lg" />
 * <TimerDisplay totalSeconds={10800} warning />
 * ```
 */
export function TimerDisplay({
  mode = 'elapsed',
  openedAt,
  now,
  totalSeconds = 0,
  size = 'md',
  warning = false,
  critical = false,
  className,
}: TimerDisplayProps) {
  const isTabOpen = mode === 'tabOpen';
  const ref = now ?? new Date();
  const formatted =
    isTabOpen && openedAt ? formatTimeOpen(openedAt, ref) : formatElapsed(totalSeconds);
  const secondsForIso =
    isTabOpen && openedAt
      ? Math.max(0, Math.floor((ref.getTime() - openedAt.getTime()) / 1000))
      : totalSeconds;

  return (
    <time
      className={cn(
        isTabOpen ? 'tabular-nums' : 'font-mono tabular-nums',
        sizeClasses[size],
        warning && 'text-warning-strong',
        critical && 'text-destructive',
        className
      )}
      dateTime={`PT${String(secondsForIso)}S`}
      aria-label={isTabOpen ? `Open for ${formatted}` : `${formatted} elapsed`}
    >
      {formatted}
    </time>
  );
}

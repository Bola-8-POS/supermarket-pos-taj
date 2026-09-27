import { useEffect, useState } from 'react';
import { cn } from '@shared/lib/utils';

export type LiveTimeDisplayProps = {
  className?: string;
};

/**
 * Local time that refreshes every minute (for page headers).
 */
export function LiveTimeDisplay({ className }: LiveTimeDisplayProps) {
  const [label, setLabel] = useState(() =>
    new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date())
  );

  useEffect(() => {
    const tick = () => {
      setLabel(
        new Intl.DateTimeFormat(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date())
      );
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  return (
    <span
      data-testid="live-time-display"
      className={cn('text-muted-foreground text-sm tabular-nums', className)}
      suppressHydrationWarning
    >
      {label}
    </span>
  );
}

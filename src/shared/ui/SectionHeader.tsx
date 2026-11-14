/**
 * SECTION HEADER COMPONENT
 *
 * Page / section title row: title (h2), optional description, optional count
 * badge, optional action slot. The former per-page "Back home" button is gone —
 * navigation lives in the app shell's sidebar now — but the `backTo`/`backLabel`
 * props stay accepted (and ignored) so every call-site keeps compiling.
 */

import { cn } from '@shared/lib/utils';
import { Badge } from '@shared/ui/badge';

export type SectionHeaderProps = {
  /** Section title */
  title: string;
  /** Optional description */
  description?: string;
  /** Optional action button or element */
  action?: React.ReactNode;
  /** Optional badge (count or label) */
  badge?: string | number;
  /** Additional CSS classes */
  className?: string;
  /** Legacy — navigation is owned by the app shell. Accepted for compatibility, ignored. */
  backTo?: string;
  /** Legacy — navigation is owned by the app shell. Accepted for compatibility, ignored. */
  backLabel?: string;
  /** Visual size — `page` for the route title, `section` for in-page groups. */
  size?: 'page' | 'section';
};

export function SectionHeader({
  title,
  description,
  action,
  badge,
  className,
  size = 'section',
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-3',
        size === 'section' && 'mb-4 border-b border-border pb-3',
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2.5">
          <h2
            className={cn(
              'truncate font-semibold tracking-tight',
              size === 'page' ? 'text-2xl' : 'text-lg'
            )}
          >
            {title}
          </h2>
          {badge !== undefined && (
            <Badge variant="muted" aria-label={`Count: ${String(badge)}`}>
              {badge}
            </Badge>
          )}
        </div>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>

      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

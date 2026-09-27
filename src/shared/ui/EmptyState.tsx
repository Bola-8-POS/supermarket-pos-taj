/**
 * EMPTY STATE COMPONENT
 *
 * Displays a centered empty state with icon, title, description, and optional action.
 * Used when lists or tables have no data.
 */

import type { LucideIcon } from 'lucide-react';
import { cn } from '@shared/lib/utils';
import { Button } from '@shared/ui/button';

export type EmptyStateProps = {
  /** Lucide icon component */
  icon: LucideIcon;
  /** Main title */
  title: string;
  /** Optional description */
  description?: string;
  /** Optional action button */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Additional CSS classes */
  className?: string;
};

/**
 * Empty state component for lists and tables.
 *
 * @example
 * ```tsx
 * <EmptyState
 *   icon={FileText}
 *   title="No tabs open"
 *   description="Open a new tab to get started"
 *   action={{
 *     label: "Open Tab",
 *     onClick: handleOpenTab
 *   }}
 * />
 * ```
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-14 text-center animate-fade-in',
        className
      )}
      data-testid="empty-state"
      role="status"
      aria-live="polite"
    >
      <div className="relative mb-5">
        <div
          className="absolute inset-0 scale-150 rounded-full bg-brand-soft/60 blur-xl"
          aria-hidden="true"
        />
        <div className="relative flex size-14 items-center justify-center rounded-2xl border border-border bg-card shadow-xs">
          <Icon className="size-6 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
        </div>
      </div>

      <h3 className="mb-1.5 text-base font-semibold tracking-tight">{title}</h3>

      {description && (
        <p className="mb-6 max-w-sm text-sm leading-relaxed text-muted-foreground text-pretty">
          {description}
        </p>
      )}

      {action && (
        <Button onClick={action.onClick} aria-label={action.label}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

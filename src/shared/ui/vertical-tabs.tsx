/**
 * VERTICAL TABS
 *
 * Grouped, left-rail tab navigation for settings-style and report-style
 * pages. Thin styling over the Radix Tabs primitives in ./tabs so every
 * trigger keeps role="tab" and every consumer keeps using <Tabs>/<TabsContent>.
 * Below the `lg` breakpoint the rail collapses to a horizontally scrolling
 * row; group labels and descriptions hide there.
 */

import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@shared/lib/utils';

import { TabsList, TabsTrigger } from './tabs';

export function VerticalTabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        'flex h-auto w-full flex-row items-stretch justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 text-muted-foreground',
        'lg:flex-col lg:gap-0.5 lg:overflow-visible',
        className
      )}
      {...props}
    />
  );
}

export function VerticalTabsGroupLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      aria-hidden="true"
      className={cn(
        'hidden px-3 pt-4 pb-1.5 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase first:pt-1 lg:block',
        className
      )}
    >
      {children}
    </p>
  );
}

export interface VerticalTabsTriggerProps
  extends Omit<React.ComponentProps<typeof TabsTrigger>, 'children'> {
  label: string;
  icon?: LucideIcon;
  /** One-line hint under the label. Decorative — excluded from the accessible name. */
  description?: string;
  /** Trailing element (count badge). Rendered `aria-hidden` — never joins the accessible name. */
  badge?: React.ReactNode;
}

export function VerticalTabsTrigger({
  label,
  icon: Icon,
  description,
  badge,
  className,
  ...props
}: VerticalTabsTriggerProps) {
  return (
    <TabsTrigger
      className={cn(
        'group/vtab relative h-auto min-h-11 flex-none justify-start gap-3 rounded-lg px-3 py-2 text-left whitespace-normal',
        'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs',
        'lg:w-full',
        className
      )}
      {...props}
      aria-label={label}
    >
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-0 hidden h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand opacity-0 transition-opacity duration-150 group-data-[state=active]/vtab:opacity-100 lg:block"
      />
      {Icon && (
        <Icon
          className="size-4 shrink-0 text-muted-foreground transition-colors group-data-[state=active]/vtab:text-brand"
          aria-hidden="true"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{label}</span>
        {description && (
          <span
            aria-hidden="true"
            className="hidden truncate text-xs font-normal text-muted-foreground lg:block"
          >
            {description}
          </span>
        )}
      </span>
      {badge && <span aria-hidden="true">{badge}</span>}
    </TabsTrigger>
  );
}

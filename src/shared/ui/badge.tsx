/**
 * BADGE COMPONENT (shadcn/ui, restyled)
 *
 * Soft, square-cornered status chips. Semantic variants use the tinted
 * `*-soft` surfaces so a wall of badges reads as labels, not buttons.
 */

/* eslint-disable react-refresh/only-export-components */

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@shared/lib/utils';

const badgeVariants = cva(
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium leading-none whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>svg]:size-3 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive-soft text-destructive',
        outline: 'border-border-strong bg-transparent text-foreground',
        brand: 'border-transparent bg-brand-soft text-brand-strong',
        success: 'border-transparent bg-success-soft text-success-strong',
        warning: 'border-transparent bg-warning-soft text-warning-strong',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@shared/lib/utils';

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-xl border px-4 py-3 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-card-foreground',
        destructive:
          'border-destructive/25 bg-destructive-soft text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current',
        warning:
          'border-warning/40 bg-warning-soft text-warning-strong *:data-[slot=alert-description]:text-warning-strong/90',
        success:
          'border-success/30 bg-success-soft text-success-strong *:data-[slot=alert-description]:text-success-strong/90',
        info: 'border-brand/30 bg-brand-soft text-brand-strong *:data-[slot=alert-description]:text-brand-strong/90',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-semibold group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
        className
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn('absolute top-2.5 right-2.5', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };

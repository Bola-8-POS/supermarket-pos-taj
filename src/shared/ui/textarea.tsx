/**
 * TEXTAREA COMPONENT (shadcn/ui, restyled)
 */

/* eslint-disable react/prop-types */

import * as React from 'react';
import { cn } from '@shared/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[88px] w-full rounded-lg border border-input bg-card px-3.5 py-2.5 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150 outline-none',
          'placeholder:text-muted-foreground/80 hover:border-border-strong',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 dark:bg-input/20',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };

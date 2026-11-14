/**
 * INPUT COMPONENT (shadcn/ui, restyled)
 */

/* eslint-disable react/prop-types */

import * as React from 'react';
import { cn } from '@shared/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3.5 py-2 text-sm text-foreground shadow-xs transition-[border-color,box-shadow,background-color] duration-150 outline-none',
          'placeholder:text-muted-foreground/80',
          'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'hover:border-border-strong',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
          'disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60',
          'dark:bg-input/20 dark:hover:border-border-strong',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };

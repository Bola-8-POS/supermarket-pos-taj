/**
 * FORM FIELD COMPONENT
 *
 * Consistent wrapper for form inputs with label, error, and hint.
 */

import * as React from 'react';
import { cn } from '@shared/lib/utils';

export interface FormFieldProps {
  /** Field label */
  label: string;
  /** Error message to display */
  error?: string;
  /** Whether field is required */
  required?: boolean;
  /** Hint text to display below input */
  hint?: string;
  /** Form input element */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

/**
 * FormField - Consistent form field wrapper
 *
 * Features:
 * - Label with optional required asterisk
 * - Error message in red below input
 * - Hint text in gray below input
 * - Accessible with proper ARIA labels
 *
 * @example
 * ```tsx
 * <FormField
 *   label="Customer Name"
 *   required
 *   error={errors.name}
 *   hint="Enter first and last name"
 * >
 *   <Input value={name} onChange={(e) => setName(e.target.value)} />
 * </FormField>
 * ```
 */
export function FormField({
  label,
  error,
  required = false,
  hint,
  children,
  className,
}: FormFieldProps) {
  const id = React.useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* Label */}
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground/90">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </label>

      {/* Input (clone with id and aria attributes) */}
      {React.isValidElement(children) &&
        React.cloneElement(
          children as React.ReactElement<{
            id?: string;
            'aria-invalid'?: string;
            'aria-describedby'?: string;
          }>,
          {
            id,
            'aria-invalid': error ? 'true' : 'false',
            ...(cn(error && errorId, hint && hintId).trim() && {
              'aria-describedby': cn(error && errorId, hint && hintId).trim(),
            }),
          }
        )}

      {/* Error Message */}
      {error && (
        <p id={errorId} className="text-[0.8125rem] font-medium text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* Hint Text */}
      {hint && !error && (
        <p id={hintId} className="text-[0.8125rem] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

import { CheckIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@shared/lib/utils';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-input bg-card shadow-xs transition-colors duration-150 outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 data-checked:border-brand data-checked:bg-brand data-checked:text-brand-foreground',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5 [&>svg]:stroke-[3]"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

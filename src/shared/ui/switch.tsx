import { Switch as SwitchPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@shared/lib/utils';

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-[background-color,border-color,box-shadow] duration-200 outline-none after:absolute after:-inset-3 focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-5 rounded-full bg-card shadow-sm ring-0 transition-transform duration-200 ease-out-quart data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0.5 dark:data-[state=checked]:bg-brand-foreground dark:data-[state=unchecked]:bg-foreground'
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

import { Tabs as TabsPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@shared/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-3', className)}
      {...props}
    />
  );
}

/**
 * Segmented control. Sits inside a muted track; the active trigger lifts to a
 * card surface with a hairline shadow.
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex h-11 w-fit items-center justify-center gap-1 rounded-xl bg-muted p-1 text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-full min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-transparent px-3.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-150',
        'hover:text-foreground',
        'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-surface-raised',
        "[&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none data-[state=active]:animate-fade-in', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };

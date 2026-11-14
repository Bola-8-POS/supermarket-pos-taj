/**
 * LABEL COMPONENT (shadcn/ui, restyled)
 */

import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@shared/lib/utils';

const labelVariants = cva(
  'text-[0.8125rem] font-medium leading-none text-foreground/90 select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-60'
);

const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };

/**
 * SKELETON COMPONENT (shadcn/ui, restyled)
 *
 * Shimmering placeholder block that matches the shape of the content it
 * stands in for.
 */

import { cn } from '@shared/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton-shimmer rounded-md', className)} {...props} />;
}

export { Skeleton };

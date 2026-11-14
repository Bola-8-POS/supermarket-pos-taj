/**
 * SCROLL AREA COMPONENT
 *
 * Thin wrapper around shadcn ScrollArea with consistent styling.
 * Used in: product grid, tab list, order history.
 */

import * as React from 'react';

import { cn } from '@shared/lib/utils';

import { ScrollAreaRoot } from './scroll-area';

export interface ScrollAreaProps {
  /** Content to scroll */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Maximum height (e.g., "400px", "50vh") */
  maxHeight?: string;
}

/**
 * ScrollArea - Consistent scrollable container
 *
 * Features:
 * - Thin scrollbar (2.5px) that appears on hover
 * - Smooth scrolling behavior
 * - Consistent styling across all scrollable areas
 * - Optional max height constraint
 *
 * @example
 * ```tsx
 * <ScrollArea maxHeight="400px">
 *   <ProductGrid products={products} />
 * </ScrollArea>
 * ```
 */
export function ScrollArea({ children, className, maxHeight = '100%' }: ScrollAreaProps) {
  return (
    <ScrollAreaRoot className={cn('w-full', className)} style={{ maxHeight }}>
      {children}
    </ScrollAreaRoot>
  );
}

/**
 * LOADING SKELETONS
 *
 * Reusable skeleton components for common loading states.
 */

import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/utils';
import { Skeleton } from '@shared/ui/skeleton';

// ============================================================================
// CARD SKELETON
// ============================================================================

export type CardSkeletonProps = {
  /** Card height */
  height?: string | number;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Skeleton for a card component.
 *
 * @example
 * ```tsx
 * <CardSkeleton height={200} />
 * ```
 */
export function CardSkeleton({ height = 200, className }: CardSkeletonProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn('rounded-xl border bg-card p-4', className)}
      style={{ height: typeof height === 'number' ? `${String(height)}px` : height }}
      aria-label={t('loading.generic')}
      role="status"
    >
      <div className="space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

// ============================================================================
// TABLE ROW SKELETON
// ============================================================================

export type TableRowSkeletonProps = {
  /** Number of columns */
  columns?: number;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Skeleton for a table row.
 *
 * @example
 * ```tsx
 * <TableRowSkeleton columns={4} />
 * ```
 */
export function TableRowSkeleton({ columns = 4, className }: TableRowSkeletonProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn('flex items-center gap-4 border-b py-4', className)}
      aria-label={t('loading.generic')}
      role="status"
    >
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className="h-4 flex-1" />
      ))}
    </div>
  );
}

// ============================================================================
// PRODUCT GRID SKELETON
// ============================================================================

export type ProductGridSkeletonProps = {
  /** Number of items to show */
  count?: number;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Skeleton for a product grid (8 items by default).
 *
 * @example
 * ```tsx
 * <ProductGridSkeleton count={8} />
 * ```
 */
export function ProductGridSkeleton({ count = 8, className }: ProductGridSkeletonProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn('grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4', className)}
      aria-label={t('loading.products')}
      role="status"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <Skeleton className="mb-3 h-20 w-full" />
          <Skeleton className="mb-2 h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// POOL TABLE GRID SKELETON
// ============================================================================

export type PoolTableGridSkeletonProps = {
  /** Number of tables to show */
  count?: number;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Skeleton for a pool table grid (6 tables by default).
 *
 * @example
 * ```tsx
 * <PoolTableGridSkeleton count={6} />
 * ```
 */
export function PoolTableGridSkeleton({ count = 6, className }: PoolTableGridSkeletonProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn('grid grid-cols-2 gap-4 md:grid-cols-3', className)}
      aria-label={t('loading.poolTables')}
      role="status"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="mb-2 h-8 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// TAB LIST SKELETON
// ============================================================================

export type TabListSkeletonProps = {
  /** Number of tabs to show */
  count?: number;
  /** Additional CSS classes */
  className?: string;
};

/**
 * Skeleton for a tab list.
 *
 * @example
 * ```tsx
 * <TabListSkeleton count={5} />
 * ```
 */
export function TabListSkeleton({ count = 5, className }: TabListSkeletonProps) {
  const { t } = useTranslation('common');
  return (
    <div className={cn('space-y-3', className)} aria-label={t('loading.tabs')} role="status">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="mb-2 h-4 w-24" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

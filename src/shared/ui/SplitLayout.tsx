/**
 * SPLIT LAYOUT COMPONENT
 *
 * 60/40 split layout used for the main POS screen.
 * Responsive: stacked on mobile with tab switcher.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@shared/lib/utils';

import { Button } from './button';

export interface SplitLayoutProps {
  /** Left panel content */
  left: React.ReactNode;
  /** Right panel content */
  right: React.ReactNode;
  /** Left panel weight (percentage, default: 60) */
  leftWeight?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * SplitLayout - Responsive split layout
 *
 * Features:
 * - CSS Grid-based split with configurable ratio
 * - Desktop (â‰¥768px): side-by-side panels
 * - Mobile (<768px): stacked with tab switcher
 * - Smooth transitions between layouts
 *
 * @example
 * ```tsx
 * <SplitLayout
 *   left={<ProductGrid products={products} />}
 *   right={<TabDrawer tab={activeTab} />}
 *   leftWeight={60}
 * />
 * ```
 */
export function SplitLayout({ left, right, leftWeight = 60, className }: SplitLayoutProps) {
  const { t } = useTranslation('common');
  const [activePanel, setActivePanel] = React.useState<'left' | 'right'>('left');

  const rightWeight = 100 - leftWeight;

  return (
    <>
      {/* Mobile Tab Switcher (< 768px) */}
      <div className="mb-4 flex gap-2 md:hidden">
        <Button
          variant={activePanel === 'left' ? 'default' : 'outline'}
          className="flex-1"
          onClick={() => {
            setActivePanel('left');
          }}
        >
          {t('splitLayout.products')}
        </Button>
        <Button
          variant={activePanel === 'right' ? 'default' : 'outline'}
          className="flex-1"
          onClick={() => {
            setActivePanel('right');
          }}
        >
          {t('splitLayout.currentTab')}
        </Button>
      </div>

      {/* Split Layout */}
      <div
        className={cn(
          'grid h-full gap-4',
          // Mobile: single column, show active panel only
          'grid-cols-1 md:grid-cols-[var(--left-weight)_var(--right-weight)]',
          className
        )}
        style={
          {
            '--left-weight': `${String(leftWeight)}fr`,
            '--right-weight': `${String(rightWeight)}fr`,
          } as React.CSSProperties
        }
      >
        {/* Left Panel */}
        <div
          className={cn(
            'h-full overflow-hidden',
            // Hide on mobile if right panel is active
            activePanel === 'right' && 'hidden md:block'
          )}
        >
          {left}
        </div>

        {/* Right Panel */}
        <div
          className={cn(
            'h-full overflow-hidden',
            // Hide on mobile if left panel is active
            activePanel === 'left' && 'hidden md:block'
          )}
        >
          {right}
        </div>
      </div>
    </>
  );
}

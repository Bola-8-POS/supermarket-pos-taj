/**
 * PAGE CONTAINER COMPONENT
 *
 * Standard route body: a sticky title bar (title, description, actions) over a
 * scrolling content well. Fills whatever height the app shell hands it.
 */

import * as React from 'react';

import { cn } from '@shared/lib/utils';

import { SectionHeader } from './SectionHeader';

export interface PageContainerProps {
  /** Page content */
  children: React.ReactNode;
  /** Page title */
  title: string;
  /** Optional page description */
  description?: string;
  /** Optional actions slot (e.g., buttons) */
  actions?: React.ReactNode;
  /** Additional CSS classes for the content well */
  className?: string;
  /** Legacy — navigation is owned by the app shell. Accepted for compatibility, ignored. */
  backTo?: string;
  /** Legacy — navigation is owned by the app shell. Accepted for compatibility, ignored. */
  backLabel?: string;
  /** `contained` (default) caps content width; `fluid` lets it stretch edge to edge. */
  width?: 'contained' | 'fluid';
  /** Remove the content well's padding (for full-bleed layouts such as split panes). */
  flush?: boolean;
}

export function PageContainer({
  children,
  title,
  description,
  actions,
  className,
  width = 'contained',
  flush = false,
}: PageContainerProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/85 px-6 py-4 backdrop-blur-md supports-backdrop-filter:bg-background/70 lg:px-8">
        <div className={cn('mx-auto w-full', width === 'contained' && 'max-w-[1440px]')}>
          <SectionHeader
            size="page"
            title={title}
            {...(description && { description })}
            {...(actions && { action: actions })}
          />
        </div>
      </header>

      <div
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          !flush && 'px-6 py-6 lg:px-8',
          flush && 'flex flex-col'
        )}
      >
        <div
          className={cn(
            'mx-auto w-full animate-fade-up',
            width === 'contained' && 'max-w-[1440px]',
            !flush && 'space-y-6',
            flush && 'flex min-h-0 flex-1 flex-col',
            className
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * TABLE PAGER
 *
 * Minimal prev/next pager for report tables that render a plain <Table>
 * instead of DataTable (which has its own row model but no pagination).
 * Client-side only — slices an already-fetched row array so a large result
 * set never renders every row into the DOM at once.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from './button';

export type TablePagerProps = {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
};

export function TablePager({ page, pageCount, onPageChange }: TablePagerProps) {
  const { t } = useTranslation('common');

  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label={t('dataTable.pager.navLabel')}
      className="flex items-center justify-end gap-3 px-1"
    >
      <span className="text-sm text-muted-foreground" aria-live="polite">
        {t('dataTable.pager.pageInfo', { page: page + 1, totalPages: pageCount })}
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          // aria-disabled (not disabled) so a focused button keeps focus when it becomes inert
          aria-disabled={page === 0}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => {
            if (page === 0) return;
            onPageChange(page - 1);
          }}
          aria-label={t('dataTable.pager.previous')}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          // aria-disabled (not disabled) so a focused button keeps focus when it becomes inert
          aria-disabled={page >= pageCount - 1}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          onClick={() => {
            if (page >= pageCount - 1) return;
            onPageChange(page + 1);
          }}
          aria-label={t('dataTable.pager.next')}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

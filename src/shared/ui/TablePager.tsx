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
    <div className="flex items-center justify-end gap-3 px-1">
      <span className="text-sm text-muted-foreground">
        {t('dataTable.pager.pageInfo', { page: page + 1, totalPages: pageCount })}
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={page === 0}
          onClick={() => {
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
          disabled={page >= pageCount - 1}
          onClick={() => {
            onPageChange(page + 1);
          }}
          aria-label={t('dataTable.pager.next')}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

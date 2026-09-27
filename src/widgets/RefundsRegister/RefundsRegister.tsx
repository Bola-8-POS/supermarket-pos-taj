import { Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useRefundsRegister } from '@entities/tab/model/queries-reports';
import type { RefundRegisterRow } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { EmptyState, LoadingSpinner, TablePager } from '@shared/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@shared/ui/table';

type Props = { dateRange: { from: Date; to: Date } };

// useRefundsRegister fetches every refund row in range with no server-side
// limit (it's a per-refund register, not an aggregate) — paginate client-side
// so a long date range never mounts hundreds of rows into the DOM at once.
const PAGE_SIZE = 25;

export function RefundsRegister({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useRefundsRegister(dateRange.from, dateRange.to);

  // Reset to page 0 when the date range changes, without an Effect (React's
  // "adjusting state when a prop changes" pattern) — an Effect would commit
  // page 0's stale render first, then re-render once the setState lands.
  const rangeKey = `${String(dateRange.from.getTime())}-${String(dateRange.to.getTime())}`;
  const [pager, setPager] = useState({ page: 0, rangeKey });
  if (pager.rangeKey !== rangeKey) {
    setPager({ page: 0, rangeKey });
  }
  const page = pager.rangeKey === rangeKey ? pager.page : 0;
  const setPage = (p: number) => {
    setPager({ page: p, rangeKey });
  };

  if (isLoading) return <LoadingSpinner />;

  const rows: RefundRegisterRow[] = result?.ok ? result.data : [];

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title={t('refundsRegister.emptyTitle')}
        description={t('refundsRegister.emptyDescription')}
      />
    );
  }

  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const totalItems = rows.reduce((s, r) => s + r.items.length, 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pagedRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto">
          <ExportButtons reportType="refunds-register" data={{ rows, dateRange }} />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('refundsRegister.columnDate')}</TableHead>
              <TableHead>{t('refundsRegister.columnOperator')}</TableHead>
              <TableHead>{t('refundsRegister.columnTab')}</TableHead>
              <TableHead className="tabular-nums">{t('refundsRegister.columnItems')}</TableHead>
              <TableHead className="tabular-nums">{t('refundsRegister.columnAmount')}</TableHead>
              <TableHead>{t('refundsRegister.columnReason')}</TableHead>
              <TableHead className="tabular-nums">{t('refundsRegister.columnRestock')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedRows.map(row => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-sm">
                  {new Date(row.date).toLocaleDateString('es-MX')}
                </TableCell>
                <TableCell>{row.operatorName}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {t('refundsRegister.truncatedId', { id: row.originalPaymentId.slice(0, 8) })}
                </TableCell>
                <TableCell className="tabular-nums">{row.items.length}</TableCell>
                <TableCell className="tabular-nums">{formatMoney(row.amount)}</TableCell>
                <TableCell className="text-muted-foreground">{row.reason}</TableCell>
                <TableCell className="tabular-nums">
                  {row.restockCount > 0 ? row.restockCount : '—'}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>{t('refundsRegister.totalLabel')}</TableCell>
              <TableCell>—</TableCell>
              <TableCell>—</TableCell>
              <TableCell className="tabular-nums">{totalItems}</TableCell>
              <TableCell className="tabular-nums">{formatMoney(totalAmount)}</TableCell>
              <TableCell>—</TableCell>
              <TableCell>—</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <TablePager page={page} pageCount={pageCount} onPageChange={setPage} />
    </div>
  );
}

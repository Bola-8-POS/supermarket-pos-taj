import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useCajaList, useCajaReport } from '@entities/caja';
import type { CajaEntry, CajaReport, CajaSession } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { DataTable } from '@shared/ui/DataTable';
import { LoadingSpinner } from '@shared/ui/LoadingSpinner';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Badge } from '@shared/ui/badge';

function formatDate(d: Date) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildTopProductsColumns(
  t: TFunction<'wPanels'>
): ColumnDef<CajaReport['topProducts'][number]>[] {
  return [
    { accessorKey: 'productName', header: t('cajaReportPanel.product') },
    { accessorKey: 'quantity', header: t('cajaReportPanel.qty') },
    {
      accessorKey: 'revenue',
      header: t('cajaReportPanel.revenue'),
      cell: ({ row }) => <MoneyDisplay amount={row.original.revenue} size="sm" />,
    },
  ];
}

function buildStaffColumns(
  t: TFunction<'wPanels'>
): ColumnDef<CajaReport['staffSummary'][number]>[] {
  return [
    { accessorKey: 'staffName', header: t('cajaReportPanel.staff') },
    { accessorKey: 'orderCount', header: t('cajaReportPanel.orders') },
    {
      accessorKey: 'salesTotal',
      header: t('cajaReportPanel.salesTotal'),
      cell: ({ row }) => <MoneyDisplay amount={row.original.salesTotal} size="sm" />,
    },
  ];
}

function buildEntriesColumns(t: TFunction<'wPanels'>): ColumnDef<CajaEntry>[] {
  return [
    {
      accessorKey: 'type',
      header: t('cajaReportPanel.type'),
      cell: ({ row }) => (
        <Badge
          variant={row.original.type === 'expense' ? 'destructive' : 'default'}
          className="capitalize"
        >
          {row.original.type}
        </Badge>
      ),
    },
    { accessorKey: 'concept', header: t('cajaReportPanel.concept') },
    {
      accessorKey: 'amount',
      header: t('cajaReportPanel.amount'),
      cell: ({ row }) => (
        <span
          className={row.original.type === 'expense' ? 'text-destructive' : 'text-success-strong'}
        >
          {formatMoney(
            row.original.type === 'expense' ? -row.original.amount : row.original.amount,
            { showSign: true }
          )}
        </span>
      ),
    },
    {
      accessorKey: 'staffName',
      header: t('cajaReportPanel.staff'),
      cell: ({ row }) => <span>{row.original.staffName ?? '—'}</span>,
    },
    {
      accessorKey: 'createdAt',
      header: t('cajaReportPanel.time'),
      cell: ({ row }) =>
        row.original.createdAt.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        }),
    },
  ];
}

export function CajaReportPanel() {
  const { t } = useTranslation('wPanels');
  const { data: listResult, isLoading: listLoading } = useCajaList();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessions = listResult?.ok ? listResult.data : [];
  const effectiveId = selectedId ?? sessions[0]?.id ?? null;

  const { data: reportResult, isLoading: reportLoading } = useCajaReport(effectiveId);
  const report = reportResult?.ok ? reportResult.data : null;

  const topProductsColumns = useMemo(() => buildTopProductsColumns(t), [t]);
  const staffColumns = useMemo(() => buildStaffColumns(t), [t]);
  const entriesColumns = useMemo(() => buildEntriesColumns(t), [t]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SectionHeader
        title={t('cajaReportPanel.dailyCajaReport')}
        description={t('cajaReportPanel.salesSummaryDescription')}
      />

      {listLoading && <LoadingSpinner />}

      {!listLoading && (
        <div className="flex items-center gap-3">
          <label htmlFor="caja-selector" className="text-sm font-medium">
            {t('cajaReportPanel.selectSession')}
          </label>
          <select
            id="caja-selector"
            value={effectiveId ?? ''}
            onChange={e => {
              setSelectedId(e.target.value || null);
            }}
            className="h-11 rounded-lg border border-input bg-card px-3 shadow-xs dark:bg-input/20 py-2 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
          >
            {sessions.map((s: CajaSession) => (
              <option key={s.id} value={s.id}>
                {formatDate(s.openedAt)}{' '}
                {s.status === 'open' ? t('cajaReportPanel.openSuffix') : ''}
              </option>
            ))}
          </select>
          {report && <ExportButtons reportType="caja" data={report} />}
        </div>
      )}

      {reportLoading && <LoadingSpinner />}

      {report && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {[
              { label: t('cajaReportPanel.totalRevenue'), value: report.summary.totalRevenue },
              { label: t('cajaReportPanel.cashSales'), value: report.summary.cashSales },
              { label: t('cajaReportPanel.cardSales'), value: report.summary.cardSales },
              { label: t('cajaReportPanel.rappiSales'), value: report.summary.rappiSales },
              { label: t('cajaReportPanel.uberEatsSales'), value: report.summary.uberEatsSales },
              {
                label: t('cajaReportPanel.bankTransferSales'),
                value: report.summary.bankTransferSales,
              },
              {
                label: t('cajaReportPanel.bankTransferPending'),
                value: report.summary.bankTransferPending,
              },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl border border-border bg-card p-4 shadow-xs">
                <p className="text-sm text-muted-foreground">{label}</p>
                <MoneyDisplay amount={value} size="lg" className="mt-1 font-bold" />
              </div>
            ))}
            <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
              <p className="text-sm text-muted-foreground">{t('cajaReportPanel.tabsOrders')}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {report.summary.tabCount} / {report.summary.orderCount}
              </p>
            </div>
          </div>

          {/* Cash reconciliation */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
            <h3 className="mb-3 font-semibold">{t('cajaReportPanel.cashReconciliation')}</h3>
            <div className="space-y-2 text-sm">
              {[
                {
                  label: t('cajaReportPanel.openingCashLabel'),
                  value: report.cashReconciliation.openingCash,
                },
                {
                  label: t('cajaReportPanel.cashCollected'),
                  value: report.cashReconciliation.cashSales,
                },
                {
                  label: t('cajaReportPanel.expectedInDrawer'),
                  value: report.cashReconciliation.expectedCash,
                },
                {
                  label: t('cajaReportPanel.closingCount'),
                  value: report.cashReconciliation.closingCash,
                },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between">
                  <span className="text-muted-foreground">{label}</span>
                  {value != null ? (
                    <MoneyDisplay amount={value} size="sm" />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              ))}
              {report.summary.totalIncome > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t('cajaReportPanel.incomeEntries')}
                  </span>
                  <span className="text-success-strong">
                    {formatMoney(report.summary.totalIncome)}
                  </span>
                </div>
              )}
              {report.summary.totalExpenses > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t('cajaReportPanel.expenseEntries')}
                  </span>
                  <span className="text-destructive">
                    {formatMoney(report.summary.totalExpenses)}
                  </span>
                </div>
              )}
              {(report.summary.totalExpenses > 0 || report.summary.totalIncome > 0) && (
                <div className="flex justify-between font-semibold">
                  <span>{t('cajaReportPanel.netBalance')}</span>
                  <MoneyDisplay amount={report.summary.netBalance} size="sm" />
                </div>
              )}
              <div className="flex justify-between border-t pt-2 font-semibold">
                <span>{t('cajaReportPanel.variance')}</span>
                {report.cashReconciliation.variance != null ? (
                  <span
                    className={
                      report.cashReconciliation.variance === 0
                        ? 'text-green-500'
                        : 'text-destructive'
                    }
                  >
                    {formatMoney(report.cashReconciliation.variance, { showSign: true })}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </div>

          {/* Top products */}
          <div>
            <h3 className="mb-3 font-semibold">{t('cajaReportPanel.top10Products')}</h3>
            {report.topProducts.length > 0 ? (
              <DataTable columns={topProductsColumns} data={report.topProducts} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('cajaReportPanel.noProductsSold')}</p>
            )}
          </div>

          {/* Expenses & Income entries */}
          <div>
            <h3 className="mb-3 font-semibold">{t('cajaReportPanel.expensesAndIncome')}</h3>
            {report.cajaEntries.length > 0 ? (
              <>
                <DataTable columns={entriesColumns} data={report.cajaEntries} />
                <div className="mt-2 flex gap-4 text-sm">
                  <span>
                    {t('cajaReportPanel.totalExpensesLabel')}{' '}
                    <span className="text-destructive font-mono">
                      {formatMoney(report.summary.totalExpenses)}
                    </span>
                  </span>
                  <span>
                    {t('cajaReportPanel.totalIncomeLabel')}{' '}
                    <span className="text-success-strong font-mono">
                      {formatMoney(report.summary.totalIncome)}
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('cajaReportPanel.noEntriesForSession')}
              </p>
            )}
          </div>

          {/* Staff performance */}
          <div>
            <h3 className="mb-3 font-semibold">{t('cajaReportPanel.staffPerformance')}</h3>
            {report.staffSummary.length > 0 ? (
              <DataTable columns={staffColumns} data={report.staffSummary} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('cajaReportPanel.noStaffActivity')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

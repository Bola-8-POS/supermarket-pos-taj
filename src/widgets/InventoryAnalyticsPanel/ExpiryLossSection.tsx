import type { ColumnDef } from '@tanstack/react-table';
import { CalendarX } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import {
  useExpiryLossReport,
  type ShrinkageRow,
} from '@entities/inventory/model/queries-analytics';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay, SectionHeader } from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

export function ExpiryLossSection({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useExpiryLossReport(dateRange.from, dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);

  const totalLoss = useMemo(() => rows.reduce((sum, r) => sum + r.value, 0), [rows]);

  const columns: ColumnDef<ShrinkageRow>[] = useMemo(
    () => [
      {
        accessorKey: 'reason',
        header: t('expiryLossSection.columnReason'),
        cell: () => <span className="font-medium">{t('expiryLossSection.reasonExpired')}</span>,
      },
      {
        accessorKey: 'units',
        header: t('expiryLossSection.columnUnits'),
        cell: info => <span className="tabular-nums">{info.getValue<number>()}</span>,
      },
      {
        accessorKey: 'value',
        header: t('expiryLossSection.columnValue'),
        cell: info => <MoneyDisplay amount={-info.getValue<number>()} size="sm" />,
      },
    ],
    [t]
  );

  let content: ReactNode;
  if (isLoading) {
    content = <LoadingSpinner />;
  } else if (!result?.ok) {
    content = (
      <p className="text-sm text-destructive" role="alert">
        {t('expiryLossSection.errorMessage')}
      </p>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={CalendarX}
        title={t('expiryLossSection.emptyTitle')}
        description={t('expiryLossSection.emptyDescription')}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('expiryLossSection.totalLossLabel')}
          </div>
          <MoneyDisplay amount={-totalLoss} size="xl" className="font-semibold" />
        </div>

        <p className="max-w-2xl whitespace-normal text-sm text-muted-foreground">
          {t('expiryLossSection.formulaNote', {
            fromDate: dateRange.from.toLocaleDateString(),
            toDate: dateRange.to.toLocaleDateString(),
          })}
        </p>

        <DataTable
          columns={columns}
          data={rows}
          toolbar={
            rows.length > 0 ? (
              <ExportButtons reportType="expiry-loss" data={{ rows, dateRange }} />
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="expiry-loss-section">
      <SectionHeader title={t('expiryLossSection.title')} />
      {content}
    </div>
  );
}

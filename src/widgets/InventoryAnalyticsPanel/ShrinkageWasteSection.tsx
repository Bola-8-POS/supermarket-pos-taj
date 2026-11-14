import type { ColumnDef } from '@tanstack/react-table';
import { Trash2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import {
  useShrinkageWasteReport,
  type ShrinkageRow,
} from '@entities/inventory/model/queries-analytics';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay, SectionHeader } from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

// Reason -> row label mapping; keys mirror groupShrinkageByReason's bucket
// keys exactly ('unclassified_adjustments' is the D-02 pre-feature bucket).
const REASON_LABEL_KEYS: Record<string, string> = {
  waste: 'shrinkageWasteSection.reasonWaste',
  correction: 'shrinkageWasteSection.reasonCorrection',
  unclassified_adjustments: 'shrinkageWasteSection.reasonUnclassified',
};

export function ShrinkageWasteSection({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useShrinkageWasteReport(dateRange.from, dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);

  const totalLoss = useMemo(() => rows.reduce((sum, r) => sum + r.value, 0), [rows]);

  const columns: ColumnDef<ShrinkageRow>[] = useMemo(
    () => [
      {
        accessorKey: 'reason',
        header: t('shrinkageWasteSection.columnReason'),
        cell: info => {
          const reason = info.getValue<string>();
          const labelKey = REASON_LABEL_KEYS[reason];
          return (
            <div>
              <span className="font-medium">{labelKey ? t(labelKey) : reason}</span>
              {reason === 'unclassified_adjustments' && (
                <p className="text-xs text-muted-foreground">
                  {t('shrinkageWasteSection.unclassifiedHelperText')}
                </p>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: 'units',
        header: t('shrinkageWasteSection.columnUnits'),
        cell: info => <span className="tabular-nums">{info.getValue<number>()}</span>,
      },
      {
        accessorKey: 'value',
        header: t('shrinkageWasteSection.columnValue'),
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
        {t('shrinkageWasteSection.errorMessage')}
      </p>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Trash2}
        title={t('shrinkageWasteSection.emptyTitle')}
        description={t('shrinkageWasteSection.emptyDescription')}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('shrinkageWasteSection.totalLossLabel')}
          </div>
          <MoneyDisplay amount={-totalLoss} size="xl" className="font-semibold" />
        </div>

        <p className="max-w-2xl whitespace-normal text-sm text-muted-foreground">
          {t('shrinkageWasteSection.formulaNote', {
            fromDate: dateRange.from.toLocaleDateString(),
            toDate: dateRange.to.toLocaleDateString(),
          })}
        </p>

        <DataTable
          columns={columns}
          data={rows}
          toolbar={
            rows.length > 0 ? (
              <ExportButtons reportType="shrinkage-waste" data={{ rows, dateRange }} />
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="shrinkage-waste-section">
      <SectionHeader title={t('shrinkageWasteSection.title')} />
      {content}
    </div>
  );
}

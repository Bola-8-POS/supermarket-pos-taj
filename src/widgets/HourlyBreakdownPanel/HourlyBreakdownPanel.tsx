import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  Legend,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from 'recharts';
import { ExportButtons } from '@features/export-report';
import {
  useHourlyBreakdown,
  findPeakHour,
  findSlowestHour,
  type HourlyRow,
} from '@entities/tab/model/queries-reports';
import { formatMoney } from '@shared/lib/format';
import { EmptyState, LoadingSpinner, MoneyDisplay } from '@shared/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@shared/ui/table';

const CHART_COLORS = [
  'var(--chart-1)',
  'oklch(0.72 0.19 145)', // --pos-accent green for top series
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

type Props = {
  dateRange: { from: Date; to: Date };
};

function chartColor(index: number): string {
  // eslint-disable-next-line i18next/no-literal-string -- CSS custom-property value, not UI copy
  return CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)';
}

function formatHour(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${String(h12)}:00 ${ampm}`;
}

// dow: 0 (Sun) - 6 (Sat), matches JS Date.getDay() (same convention the RPC
// and aggregateHourlyRevenue use to compute HourlyRow.dayOfWeek).
const REFERENCE_SUNDAY = new Date(2026, 0, 4);
function formatDayOfWeek(dow: number, locale: string): string {
  const d = new Date(REFERENCE_SUNDAY);
  d.setDate(d.getDate() + dow);
  return d.toLocaleDateString(locale, { weekday: 'short' });
}

export function HourlyBreakdownPanel({ dateRange }: Props) {
  const { t, i18n } = useTranslation('wAdmin');
  const { data: result, isLoading } = useHourlyBreakdown(dateRange.from, dateRange.to);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const rows: HourlyRow[] = result?.ok ? result.data : [];
  const allZero = rows.every(r => r.revenue === 0);

  if (allZero) {
    return (
      <EmptyState
        icon={Clock}
        title={t('hourlyBreakdownPanel.emptyTitle')}
        description={t('hourlyBreakdownPanel.emptyDescription')}
      />
    );
  }

  const peakHour = findPeakHour(rows);
  const slowestHour = findSlowestHour(rows);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButtons reportType="hourly" data={rows} />
      </div>

      {/* Callout row */}
      {(peakHour ?? slowestHour) && (
        <div className="flex flex-wrap gap-4 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-sm">
          {peakHour && (
            <span>
              {t('hourlyBreakdownPanel.peakLabel')}{' '}
              <span className="font-semibold text-brand-strong">
                {t('hourlyBreakdownPanel.hourRevenueValue', {
                  hour: formatHour(peakHour.hour),
                  revenue: formatMoney(peakHour.revenue),
                })}
              </span>
            </span>
          )}
          {slowestHour && (
            <span>
              {t('hourlyBreakdownPanel.slowestLabel')}{' '}
              <span className="font-semibold text-warning-strong">
                {t('hourlyBreakdownPanel.hourRevenueValue', {
                  hour: formatHour(slowestHour.hour),
                  revenue: formatMoney(slowestHour.revenue),
                })}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Per-hour bar chart, busiest hour bar highlighted (D-13) */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows}>
            <XAxis dataKey="hour" tickFormatter={formatHour} />
            <YAxis />
            <Tooltip labelFormatter={label => formatHour(Number(label))} />
            <Legend />
            <Bar
              dataKey="revenue"
              name={t('hourlyBreakdownPanel.columnRevenue')}
              fill={chartColor(0)}
              shape={(props: BarShapeProps) => {
                const row = props.payload as HourlyRow;
                const isPeak = peakHour !== null && row.hour === peakHour.hour;
                return <Rectangle {...props} fill={isPeak ? chartColor(1) : chartColor(0)} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 24-row table */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('hourlyBreakdownPanel.columnHour')}</TableHead>
              <TableHead>{t('hourlyBreakdownPanel.columnDayOfWeek')}</TableHead>
              <TableHead>{t('hourlyBreakdownPanel.columnOrders')}</TableHead>
              <TableHead>{t('hourlyBreakdownPanel.columnRevenue')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => {
              const isPeak = peakHour !== null && row.hour === peakHour.hour;
              const isSlowest = slowestHour !== null && row.hour === slowestHour.hour && !isPeak;
              return (
                <TableRow
                  key={row.hour}
                  className={
                    isPeak
                      ? 'border-l-2 border-l-brand bg-brand-soft/60 text-brand-strong'
                      : isSlowest
                        ? 'border-l-2 border-l-warning bg-warning-soft/60 text-warning-strong'
                        : undefined
                  }
                >
                  <TableCell className="font-mono">{formatHour(row.hour)}</TableCell>
                  <TableCell>{formatDayOfWeek(row.dayOfWeek, i18n.language)}</TableCell>
                  <TableCell className="tabular-nums">{row.orderCount}</TableCell>
                  <TableCell>
                    <MoneyDisplay amount={row.revenue} size="sm" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

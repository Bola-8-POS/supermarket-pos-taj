import { ArrowDownUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInventory, useInventoryLog } from '@entities/inventory';
import { useStaffList } from '@entities/staff/model/queries';
import { cn } from '@shared/lib/utils';
import { EmptyState } from '@shared/ui/EmptyState';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@shared/ui/table';

// Reason enum values come from StockMovementReasonSchema (domain.ts) — the
// ledger's own enum, which is wider than InventoryAdjustReasonSchema. Reasons
// with no entry here (retired bar-pos ones like prep_production) render their
// raw value rather than being mislabelled as something else.
/* eslint-disable i18next/no-literal-string -- i18n key lookup table, not UI copy */
const REASON_LABEL_KEY: Record<string, string> = {
  waste: 'inventoryPagePanel.reasonOptionWaste',
  expired: 'inventoryPagePanel.reasonOptionExpired',
  delivery: 'inventoryPagePanel.reasonOptionDelivery',
  correction: 'inventoryPagePanel.reasonOptionCorrection',
  manual_adjustment: 'inventoryPagePanel.reasonOptionManualAdjustment',
  physical_count: 'inventoryPagePanel.reasonOptionPhysicalCount',
  sale: 'inventoryPagePanel.reasonOptionSale',
  refund: 'inventoryPagePanel.reasonOptionRefund',
};
/* eslint-enable i18next/no-literal-string */

const FILTERS = [
  'all',
  'delivery',
  'sale',
  'refund',
  'waste',
  'expired',
  'correction',
  'manual_adjustment',
  'physical_count',
] as const;
type ReasonFilter = (typeof FILTERS)[number];

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function MovementsTab() {
  const { t, i18n } = useTranslation('wAdmin');
  const { data: logs, isLoading, resultError } = useInventoryLog();
  const { data: inventory } = useInventory();
  const { data: staff } = useStaffList();
  const [filter, setFilter] = useState<ReasonFilter>('all');

  const productNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of inventory ?? []) {
      if (row.product) map.set(row.productId, row.product.name);
    }
    return map;
  }, [inventory]);

  const staffNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of staff ?? []) map.set(s.id, s.name);
    return map;
  }, [staff]);

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  );

  const visible = (logs ?? []).filter(log => filter === 'all' || log.reason === filter);

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title={t('inventoryPagePanel.changeLogTitle')}
        description={t('inventoryPagePanel.changeLogDescription')}
      />
      {/* A failed fetch must never masquerade as an empty ledger. */}
      {resultError ? (
        <p className="text-sm text-destructive" role="alert">
          {resultError.message}
        </p>
      ) : null}
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={t('inventoryPagePanel.reasonFilterLabel')}
      >
        {FILTERS.map(value => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? 'default' : 'outline'}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
            }}
          >
            {value === 'all'
              ? t('inventoryPagePanel.reasonFilterAll')
              : t(REASON_LABEL_KEY[value] ?? 'inventoryPagePanel.reasonFilterAll')}
          </Button>
        ))}
      </div>
      {!isLoading && !resultError && visible.length === 0 ? (
        <EmptyState
          icon={ArrowDownUp}
          title={t('inventoryPagePanel.noLogEntries')}
          description={t('inventoryPagePanel.noLogEntriesBody')}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('inventoryPagePanel.columnWhen')}</TableHead>
                <TableHead>{t('inventoryPagePanel.columnProduct')}</TableHead>
                <TableHead className="text-right">{t('inventoryPagePanel.columnDelta')}</TableHead>
                <TableHead>{t('inventoryPagePanel.columnReason')}</TableHead>
                <TableHead>{t('inventoryPagePanel.columnStaff')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {t('inventoryPagePanel.loading')}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map(log => {
                  // productId is nullable on stock_movements (ingredient-only
                  // movements); reasons with no label key show their raw value
                  // rather than borrowing another reason's label.
                  const productName =
                    log.productId !== null ? productNames.get(log.productId) : undefined;
                  const reasonKey = REASON_LABEL_KEY[log.reason];
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatter.format(log.createdAt)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {productName ?? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {/* eslint-disable-next-line i18next/no-literal-string -- typographic placeholder, not translatable copy */}
                            {log.productId !== null ? shortId(log.productId) : '—'}
                          </span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-semibold tabular-nums',
                          log.quantityDelta > 0 ? 'text-success-strong' : 'text-destructive'
                        )}
                      >
                        {log.quantityDelta > 0
                          ? `+${String(log.quantityDelta)}`
                          : String(log.quantityDelta)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{reasonKey ? t(reasonKey) : log.reason}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {staffNames.get(log.staffId) ?? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {shortId(log.staffId)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

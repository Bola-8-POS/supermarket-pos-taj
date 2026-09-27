import { PackageX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNearExpiryAlerts } from '@entities/inventory';
import { EmptyState } from '@shared/ui/EmptyState';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Badge } from '@shared/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@shared/ui/table';

function urgency(days: number): 'destructive' | 'warning' | 'muted' {
  if (days <= 3) return 'destructive';
  if (days <= 7) return 'warning';
  return 'muted';
}

export function NearExpiryTab() {
  const { t } = useTranslation('wAdmin');
  const { t: tEntities } = useTranslation('entities');
  const { data: alerts, isEmpty } = useNearExpiryAlerts();
  const rows = [...(alerts ?? [])].sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  if (isEmpty) {
    return (
      <EmptyState
        icon={PackageX}
        title={t('inventoryPagePanel.nothingExpiringSoonTitle')}
        description={t('inventoryPagePanel.nothingExpiringSoonBody')}
      />
    );
  }

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title={t('inventoryPagePanel.nearExpiryTabLabel')}
        description={t('inventoryPagePanel.nearExpiryDescription')}
        badge={rows.length}
      />
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tEntities('inventoryRow.columns.product')}</TableHead>
              <TableHead>{t('inventoryPagePanel.expiryDate')}</TableHead>
              <TableHead>{t('inventoryPagePanel.daysRemaining')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(alert => (
              <TableRow key={alert.productId}>
                <TableCell className="font-medium">{alert.productName}</TableCell>
                <TableCell className="text-muted-foreground">{alert.expiryDate}</TableCell>
                <TableCell>
                  <Badge variant={urgency(alert.daysUntilExpiry)} className="tabular-nums">
                    {t('inventoryPagePanel.daysBadge', { count: alert.daysUntilExpiry })}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

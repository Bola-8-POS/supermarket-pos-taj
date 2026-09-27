import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { useInventoryAlerts } from '../model/queries';

/**
 * Displays a destructive badge with the count of low-stock products.
 * Renders nothing when there are no low-stock alerts.
 */
export function LowStockBadge() {
  const { t } = useTranslation('entities');
  const { data: alerts, isLoading } = useInventoryAlerts();

  if (isLoading || !alerts || alerts.length === 0) return null;

  return (
    <Badge variant="destructive" className="ml-3 tabular-nums" data-testid="low-stock-badge">
      {t('lowStockBadge.count', { count: alerts.length })}
    </Badge>
  );
}

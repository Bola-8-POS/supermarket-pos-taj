import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { useNearExpiryAlerts } from '../model/queries';

/** Displays an advisory badge with the count of products nearing expiry. */
export function NearExpiryBadge() {
  const { t } = useTranslation('entities');
  const { data: alerts, isLoading } = useNearExpiryAlerts();
  if (isLoading || !alerts || alerts.length === 0) return null;
  return (
    <Badge
      className="ml-3 tabular-nums bg-warning-soft text-warning-strong"
      data-testid="near-expiry-badge"
    >
      {t('nearExpiryBadge.count', { count: alerts.length })}
    </Badge>
  );
}

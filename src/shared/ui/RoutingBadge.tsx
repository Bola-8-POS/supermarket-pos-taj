import { Beer, UtensilsCrossed } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CategoryRouting } from '@shared/lib/domain';
import { Badge } from './badge';

export function RoutingBadge({ routing }: { routing: CategoryRouting }) {
  const { t } = useTranslation('common');
  if (routing === 'NONE') return null;
  const Icon = routing === 'KITCHEN' ? UtensilsCrossed : Beer;
  const label = routing === 'KITCHEN' ? t('routingBadge.kitchen') : t('routingBadge.bar');
  return (
    <Badge variant="secondary" className="flex items-center gap-1">
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );
}

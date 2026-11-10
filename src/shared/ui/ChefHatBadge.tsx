import { ChefHat } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from './badge';

export function ChefHatBadge() {
  const { t } = useTranslation('common');
  return (
    <Badge variant="secondary" className="flex items-center gap-1">
      <ChefHat className="h-3 w-3" aria-hidden />
      {t('chefHatBadge.label')}
    </Badge>
  );
}

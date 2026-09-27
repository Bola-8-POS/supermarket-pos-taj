import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type FeatureKey } from '@shared/lib/license/features';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { EmptyState } from './EmptyState';

/** Full-page replacement for a route whose feature is not in the license. */
export function FeatureLockedPage({ feature }: { feature: FeatureKey }) {
  const { t } = useTranslation('common');
  const openFor = useUpgradeDialogStore(s => s.openFor);
  const label = t(`license.features.${feature}`);
  return (
    <div
      className="flex flex-1 items-center justify-center p-8"
      data-testid="feature-locked-page"
      data-feature={feature}
    >
      <EmptyState
        icon={Lock}
        title={t('license.locked.pageTitle', { feature: label })}
        description={t('license.locked.pageBody')}
        action={{
          label: t('license.locked.cta'),
          onClick: () => {
            openFor(feature);
          },
        }}
      />
    </div>
  );
}

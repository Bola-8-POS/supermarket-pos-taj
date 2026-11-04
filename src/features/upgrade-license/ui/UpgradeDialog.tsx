import { ExternalLink, KeyRound, Mail } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_CONTACT } from '@shared/lib/license/config';
import { FEATURE_KEYS } from '@shared/lib/license/features';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { openExternal } from '@shared/lib/open-external';
import { POSButton } from '@shared/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';

const PLAN_KEYS = ['monthly', 'yearly', 'lifetime'] as const;

export interface UpgradeDialogProps {
  /** The license-key/offline-token form. Passed in from App.tsx (app layer) — this feature
   * cannot import `features/activate-license` directly (features may not import features). */
  activationForm: ReactNode;
}

/**
 * Global "unlock the full version" dialog. Opened from anywhere via
 * `useUpgradeDialogStore.openFor(feature?)` (LockedFeature, FeatureLockedPage, DemoBar,
 * Settings → License). Mounted once in App.tsx, inside Providers, outside LicenseGate.
 */
export function UpgradeDialog({ activationForm }: UpgradeDialogProps) {
  const { t } = useTranslation(['featMgmt', 'common']);
  const open = useUpgradeDialogStore(s => s.open);
  const feature = useUpgradeDialogStore(s => s.feature);
  const close = useUpgradeDialogStore(s => s.close);
  const [showKeyForm, setShowKeyForm] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      close();
      setShowKeyForm(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="upgrade-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('upgradeLicense.title')}</DialogTitle>
        </DialogHeader>

        {feature && (
          <p data-testid="upgrade-feature-line" className="text-sm text-muted-foreground">
            {t('upgradeLicense.featureLine', { feature: t(`license.features.${feature}`, { ns: 'common' }) })}
          </p>
        )}

        <p className="text-sm text-muted-foreground">{t('upgradeLicense.intro')}</p>

        <ul className="space-y-1 text-sm font-medium">
          {PLAN_KEYS.map(plan => (
            <li key={plan}>{t(`upgradeLicense.plans.${plan}`)}</li>
          ))}
        </ul>

        <div className="space-y-1">
          <p className="text-sm font-semibold">{t('upgradeLicense.includes')}</p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {FEATURE_KEYS.map(key => (
              <li key={key}>{t(`license.features.${key}`, { ns: 'common' })}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          <POSButton
            type="button"
            touchSize="large"
            onClick={() =>
              void openExternal(
                `mailto:${DEMO_CONTACT.email}?subject=${encodeURIComponent(t('upgradeLicense.title'))}`
              )
            }
          >
            <Mail /> {t('upgradeLicense.contact')}
          </POSButton>
          <POSButton
            type="button"
            variant="secondary"
            touchSize="large"
            onClick={() => void openExternal(DEMO_CONTACT.site)}
          >
            <ExternalLink /> {DEMO_CONTACT.site}
          </POSButton>
          <POSButton
            type="button"
            variant="secondary"
            touchSize="large"
            data-testid="upgrade-have-key"
            onClick={() => {
              setShowKeyForm(v => !v);
            }}
          >
            <KeyRound /> {t('upgradeLicense.haveKey')}
          </POSButton>
        </div>

        {showKeyForm && <div className="rounded-xl border border-border p-4">{activationForm}</div>}

        <POSButton
          type="button"
          variant="secondary"
          touchSize="large"
          data-testid="upgrade-close"
          onClick={() => {
            handleOpenChange(false);
          }}
        >
          {t('upgradeLicense.close')}
        </POSButton>
      </DialogContent>
    </Dialog>
  );
}

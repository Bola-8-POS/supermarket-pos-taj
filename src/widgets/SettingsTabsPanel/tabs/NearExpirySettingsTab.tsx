import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationUpdateSetting, useSettings } from '@entities/settings';
import type { UserRole } from '@shared/lib/domain';
import { Input, Label, POSButton, ProtectedAction } from '@shared/ui';
import { useRegisterUnsavedChanges } from '../model/unsaved-changes';

type Props = { currentRole: UserRole | null };

export function NearExpirySettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data } = useSettings();
  const updateSetting = useMutationUpdateSetting();
  const [thresholdDays, setThresholdDays] = useState('14');
  const [discountPercent, setDiscountPercent] = useState('15');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- synchronize saved settings while the form is pristine */
    if (data && !dirty) {
      setThresholdDays(String(data.nearExpiry.thresholdDays));
      setDiscountPercent(String(data.nearExpiry.discountPercent));
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data, dirty]);
  const save = useCallback(async (): Promise<boolean> => {
    const value = Number(thresholdDays);
    if (!Number.isInteger(value) || value < 1 || value > 365) return false;
    const discountValue = Number(discountPercent);
    if (Number.isNaN(discountValue) || discountValue < 0 || discountValue > 100) return false;
    const result = await updateSetting.mutateAsync({
      key: 'near_expiry',
      value: { thresholdDays: value, discountPercent: discountValue },
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return false;
    }
    setDirty(false);
    toast.success(t('nearExpirySettingsTab.saved'));
    return true;
  }, [thresholdDays, discountPercent, updateSetting, t]);
  useRegisterUnsavedChanges(dirty, save);
  return (
    <ProtectedAction action="manage_settings" currentRole={currentRole} disabled={updateSetting.isPending}>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('nearExpirySettingsTab.title')}</h2>
        <div className="space-y-2">
          <Label htmlFor="near-expiry-threshold">{t('nearExpirySettingsTab.thresholdLabel')}</Label>
          <Input id="near-expiry-threshold" type="number" min={1} max={365} value={thresholdDays} onChange={event => { setDirty(true); setThresholdDays(event.target.value); }} />
          <p className="text-xs text-muted-foreground">{t('nearExpirySettingsTab.thresholdHint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="near-expiry-discount">{t('nearExpirySettingsTab.discountLabel')}</Label>
          <Input id="near-expiry-discount" type="number" min={0} max={100} value={discountPercent} onChange={event => { setDirty(true); setDiscountPercent(event.target.value); }} />
          <p className="text-xs text-muted-foreground">{t('nearExpirySettingsTab.discountHint')}</p>
        </div>
        <POSButton type="button" touchSize="large" disabled={!dirty || updateSetting.isPending} onClick={() => { void save(); }}>
          {t('nearExpirySettingsTab.saveButton')}
        </POSButton>
      </div>
    </ProtectedAction>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useEmailSettingsStatus,
  useMutationSendSettingsTestEmail,
  useMutationUpdateSetting,
  useSettings,
} from '@entities/settings';
import type { UserRole } from '@shared/lib/domain';
import { Input, Label, LockedFeature, POSButton, ProtectedAction } from '@shared/ui';
import { useRegisterUnsavedChanges } from '../model/unsaved-changes';

type Props = {
  currentRole: UserRole | null;
};

export function EmailReceiptsSettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data } = useSettings();
  const emailStatus = useEmailSettingsStatus();
  const updateSetting = useMutationUpdateSetting();
  const sendTest = useMutationSendSettingsTestEmail();
  const [fromEmail, setFromEmail] = useState('');
  const [testRecipient, setTestRecipient] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setFromEmail(data.emailReceipts.fromEmail);
    if (testRecipient.length === 0) {
      setTestRecipient(data.emailReceipts.fromEmail);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data, dirty, testRecipient.length]);

  const save = useCallback(async (): Promise<boolean> => {
    const result = await updateSetting.mutateAsync({
      key: 'email_receipts',
      value: {
        fromEmail: fromEmail.trim(),
      },
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return false;
    }
    setDirty(false);
    toast.success(t('emailReceiptsSettingsTab.saved'));
    return true;
  }, [fromEmail, updateSetting, t]);

  useRegisterUnsavedChanges(dirty, save);

  const sendTestEmail = async () => {
    const result = await sendTest.mutateAsync({ email: testRecipient.trim() });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(t('emailReceiptsSettingsTab.testEmailSent'));
  };

  return (
    <ProtectedAction
      action="manage_settings"
      currentRole={currentRole}
      disabled={updateSetting.isPending}
    >
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('emailReceiptsSettingsTab.title')}</h2>
        <div className="space-y-2">
          <Label htmlFor="settings-receipt-from-email">
            {t('emailReceiptsSettingsTab.fromEmailLabel')}
          </Label>
          <Input
            id="settings-receipt-from-email"
            value={fromEmail}
            onChange={event => {
              setDirty(true);
              setFromEmail(event.target.value);
            }}
          />
        </div>
        <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
          <span className="font-medium">{t('emailReceiptsSettingsTab.resendApiKeyLabel')}</span>{' '}
          {emailStatus.data?.resendConfigured
            ? t('emailReceiptsSettingsTab.configured')
            : t('emailReceiptsSettingsTab.notSet')}
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-test-email-recipient">
            {t('emailReceiptsSettingsTab.testRecipientLabel')}
          </Label>
          <Input
            id="settings-test-email-recipient"
            value={testRecipient}
            onChange={event => {
              setTestRecipient(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <POSButton
            type="button"
            touchSize="large"
            disabled={!dirty || updateSetting.isPending || sendTest.isPending}
            onClick={() => {
              void save();
            }}
          >
            {updateSetting.isPending
              ? t('emailReceiptsSettingsTab.saving')
              : t('emailReceiptsSettingsTab.saveEmailSettings')}
          </POSButton>
          <LockedFeature feature="email_receipts">
            <POSButton
              type="button"
              touchSize="large"
              variant="outline"
              disabled={sendTest.isPending || updateSetting.isPending}
              onClick={() => {
                void sendTestEmail();
              }}
            >
              {sendTest.isPending
                ? t('emailReceiptsSettingsTab.sending')
                : t('emailReceiptsSettingsTab.sendTestEmail')}
            </POSButton>
          </LockedFeature>
        </div>
      </div>
    </ProtectedAction>
  );
}

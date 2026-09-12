import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationUpdateSetting, useSettings } from '@entities/settings';
import type { PaymentMethodLabels } from '@entities/settings';
import { PAYMENT_METHODS, PaymentMethodLabelsSchema, type PaymentMethod } from '@shared/lib/domain';
import type { UserRole } from '@shared/lib/domain';
import { ConfirmDialog, Input, Label, POSButton, ProtectedAction } from '@shared/ui';

type Props = {
  currentRole: UserRole | null;
};

type BillingForm = {
  taxRatePercent: string;
  paymentMethods: Record<PaymentMethod, boolean>;
  taxInclusive: boolean;
};

const DEFAULT_FORM: BillingForm = {
  taxRatePercent: '16',
  paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
  taxInclusive: true,
};

const DEFAULT_LABELS: PaymentMethodLabels = {
  cash: 'Efectivo',
  card: 'Terminal',
  bank_transfer: 'Transferencia',
  rappi: 'Rappi',
  uber_eats: 'Uber Eats',
};

// Placeholders for the label inputs come from the schema's own defaults —
// single source of truth, no hand-copied placeholder strings to drift.
const SCHEMA_DEFAULT_LABELS = PaymentMethodLabelsSchema.parse({});

export function BillingSettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const { t: tCommon } = useTranslation('common');
  const { data } = useSettings();
  const updateSetting = useMutationUpdateSetting();
  const [form, setForm] = useState<BillingForm>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [labels, setLabels] = useState<PaymentMethodLabels>(DEFAULT_LABELS);
  const [labelsDirty, setLabelsDirty] = useState(false);
  // WR-03: taxInclusive reinterprets every catalog price store-wide the
  // moment it's saved — gate the save behind a confirmation whenever it
  // differs from the last-loaded value, mirroring PINLoginForm.tsx's
  // opening-cash ConfirmDialog gate.
  const [confirmingTaxInclusiveChange, setConfirmingTaxInclusiveChange] = useState(false);

  useEffect(() => {
    if (!data) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!dirty) {
      setForm({
        taxRatePercent: String(data.billing.taxRatePercent),
        paymentMethods: data.billing.paymentMethods,
        taxInclusive: data.billing.taxInclusive,
      });
    }
    if (!labelsDirty) {
      setLabels(data.paymentLabels);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data, dirty, labelsDirty]);

  const save = async () => {
    const taxRatePercent = Number(form.taxRatePercent);
    if (!Number.isFinite(taxRatePercent) || taxRatePercent < 0 || taxRatePercent > 100) {
      toast.error(t('billingSettingsTab.taxRateInvalid'));
      return;
    }

    const result = await updateSetting.mutateAsync({
      key: 'billing',
      value: {
        taxRatePercent,
        paymentMethods: form.paymentMethods,
        taxInclusive: form.taxInclusive,
      },
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setDirty(false);
    toast.success(t('billingSettingsTab.billingSaved'));
  };

  return (
    <ProtectedAction
      action="manage_products"
      currentRole={currentRole}
      disabled={updateSetting.isPending}
    >
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('billingSettingsTab.title')}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-tax-rate">{t('billingSettingsTab.taxRateLabel')}</Label>
            <Input
              id="settings-tax-rate"
              value={form.taxRatePercent}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, taxRatePercent: event.target.value }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('billingSettingsTab.taxInclusiveLabel')}</Label>
            <POSButton
              type="button"
              touchSize="large"
              variant={form.taxInclusive ? 'default' : 'outline'}
              onClick={() => {
                setDirty(true);
                setForm(current => ({ ...current, taxInclusive: !current.taxInclusive }));
              }}
            >
              {t(
                form.taxInclusive
                  ? 'billingSettingsTab.taxInclusiveOnLabel'
                  : 'billingSettingsTab.taxInclusiveOffLabel'
              )}
            </POSButton>
            <p className="text-xs text-muted-foreground">
              {t('billingSettingsTab.taxInclusiveDescription')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('billingSettingsTab.enabledPaymentMethods')}</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {PAYMENT_METHODS.map(method => (
              <POSButton
                key={method}
                type="button"
                touchSize="large"
                variant={form.paymentMethods[method] ? 'default' : 'outline'}
                data-testid={`billing-method-toggle-${method}`}
                onClick={() => {
                  setDirty(true);
                  setForm(current => ({
                    ...current,
                    paymentMethods: {
                      ...current.paymentMethods,
                      [method]: !current.paymentMethods[method],
                    },
                  }));
                }}
              >
                {t(`billingSettingsTab.methodName.${method}`)}
              </POSButton>
            ))}
          </div>
        </div>

        <POSButton
          type="button"
          touchSize="large"
          disabled={!dirty || updateSetting.isPending}
          onClick={() => {
            if (data && form.taxInclusive !== data.billing.taxInclusive) {
              setConfirmingTaxInclusiveChange(true);
              return;
            }
            void save();
          }}
        >
          {updateSetting.isPending
            ? t('billingSettingsTab.saving')
            : t('billingSettingsTab.saveBilling')}
        </POSButton>

        <ConfirmDialog
          open={confirmingTaxInclusiveChange}
          title={t('billingSettingsTab.taxInclusiveConfirmTitle')}
          description={t('billingSettingsTab.taxInclusiveConfirmDescription')}
          confirmLabel={tCommon('actions.confirm')}
          cancelLabel={tCommon('actions.cancel')}
          isLoading={updateSetting.isPending}
          onConfirm={() => {
            setConfirmingTaxInclusiveChange(false);
            void save();
          }}
          onCancel={() => {
            setConfirmingTaxInclusiveChange(false);
          }}
        />

        <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <h3 className="font-medium">{t('billingSettingsTab.paymentButtonLabelsTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('billingSettingsTab.paymentButtonLabelsDescription')}
          </p>
          {PAYMENT_METHODS.map(method => (
            <div key={method} className="flex items-center gap-3">
              <Label htmlFor={`label-${method}`} className="w-28 shrink-0">
                {t(`billingSettingsTab.methodName.${method}`)}
              </Label>
              <Input
                id={`label-${method}`}
                data-testid={`billing-method-label-${method}`}
                value={labels[method]}
                placeholder={SCHEMA_DEFAULT_LABELS[method]}
                maxLength={40}
                onChange={e => {
                  setLabelsDirty(true);
                  setLabels(prev => ({ ...prev, [method]: e.target.value }));
                }}
              />
            </div>
          ))}
          <POSButton
            type="button"
            touchSize="large"
            disabled={!labelsDirty || updateSetting.isPending}
            onClick={() => {
              updateSetting.mutate(
                { key: 'payment_labels', value: labels },
                {
                  onSuccess: result => {
                    if (!result.ok) {
                      toast.error(result.error.message);
                      return;
                    }
                    setLabelsDirty(false);
                    toast.success(t('billingSettingsTab.paymentLabelsSaved'));
                  },
                }
              );
            }}
          >
            {updateSetting.isPending
              ? t('billingSettingsTab.saving')
              : t('billingSettingsTab.saveLabels')}
          </POSButton>
        </div>
      </div>
    </ProtectedAction>
  );
}

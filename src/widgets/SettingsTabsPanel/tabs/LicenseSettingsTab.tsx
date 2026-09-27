import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LicenseActivationForm } from '@features/activate-license';
import { runHeartbeat } from '@shared/lib/license/actions';
import { getEffectiveNow, useLicenseEvaluation, useLicenseStore } from '@shared/lib/license/store';
import { getTerminalId } from '@shared/lib/license/terminal-id';
import { updatesExpired } from '@shared/lib/license/token';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { useUpdaterStore } from '@shared/lib/useAppUpdater';
import { POSButton } from '@shared/ui';

const fmt = (iso: string | null | undefined): string | null =>
  iso ? new Date(iso).toLocaleDateString() : null;

/** Read-only license status for the store admin + manual refresh / re-key. */
export function LicenseSettingsTab() {
  const { t } = useTranslation('settings');
  const evaluation = useLicenseEvaluation();
  const payload = useLicenseStore(s => s.payload);
  const lastHeartbeatAt = useLicenseStore(s => s.lastHeartbeatAt);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const checkForUpdates = useUpdaterStore(s => s.checkForUpdates);
  const openFor = useUpgradeDialogStore(s => s.openFor);
  const [showForm, setShowForm] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    const outcome = await runHeartbeat();
    setRefreshing(false);
    if (outcome === 'refreshed') toast.success(t('license.refreshed'));
    else toast.error(t('license.refreshFailed'));
  };

  // 'available' needs no toast — the global UpdateAvailableDialog opens and asks to install.
  const checkUpdates = async () => {
    setCheckingUpdates(true);
    const outcome = await checkForUpdates();
    setCheckingUpdates(false);
    if (outcome === 'none') toast.success(t('license.upToDate'));
    else if (outcome === 'error') toast.error(t('license.updateCheckFailed'));
    else if (outcome === 'skipped') toast.error(t('license.updatesExpired'));
  };

  const rows: Array<[string, string | null]> = payload
    ? [
        [t('license.tenant'), payload.tenant_name],
        [t('license.plan'), t(`license.planName.${payload.plan}`)],
        [
          payload.plan === 'demo' ? t('license.demoEnds') : t('license.periodEnd'),
          payload.period_end ? fmt(payload.period_end) : t('license.lifetimeNoExpiry'),
        ],
        ...(payload.plan === 'lifetime'
          ? [[t('license.updatesUntil'), fmt(payload.updates_until)] as [string, string | null]]
          : []),
        [t('license.leaseUntil'), fmt(payload.lease_until)],
        [
          t('license.lastHeartbeat'),
          lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleString() : t('license.never'),
        ],
        [t('license.maxTerminals'), String(payload.max_terminals)],
      ]
    : [];

  return (
    <div className="space-y-5" data-testid="license-settings-tab">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{t('license.heading')}</h2>
        <span
          data-testid="license-status"
          data-state={evaluation.state}
          className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
        >
          {t(`license.status.${evaluation.state}`)}
        </span>
      </div>

      {payload ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value ?? '—'}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">{t('license.terminalId')}</dt>
          <dd>
            <code className="select-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {getTerminalId()}
            </code>
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">{t('license.unlicensed')}</p>
      )}

      {payload && updatesExpired(payload, getEffectiveNow()) && (
        <p className="text-sm text-warning-foreground">{t('license.updatesExpired')}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('license.leaseHint')}</p>

      <div className="flex flex-wrap gap-2">
        {payload?.plan === 'demo' && (
          <POSButton
            type="button"
            touchSize="large"
            data-testid="license-get-full"
            onClick={() => {
              openFor();
            }}
          >
            {t('license.getFull')}
          </POSButton>
        )}
        <POSButton
          type="button"
          touchSize="large"
          disabled={refreshing || !payload}
          onClick={() => void refresh()}
        >
          {refreshing ? t('license.refreshing') : t('license.refresh')}
        </POSButton>
        <POSButton
          type="button"
          variant="secondary"
          touchSize="large"
          onClick={() => {
            setShowForm(v => !v);
          }}
        >
          {t('license.changeKey')}
        </POSButton>
        <POSButton
          type="button"
          variant="secondary"
          touchSize="large"
          data-testid="check-updates-button"
          disabled={checkingUpdates}
          onClick={() => void checkUpdates()}
        >
          {checkingUpdates ? t('license.checkingUpdates') : t('license.checkUpdates')}
        </POSButton>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border p-4">
          <LicenseActivationForm
            showDemo={false}
            onDone={() => {
              setShowForm(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

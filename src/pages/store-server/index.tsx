import { relaunch } from '@tauri-apps/plugin-process';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStoreStatus } from '@entities/store-status';
import { isTauri } from '@shared/lib/pos-printer';
import { openPosctlConsole, type ConsoleLaunch } from '@shared/lib/posctl-console';
import { alertInfo, statusAgeMs, type ConsoleAction } from '@shared/lib/store-alerts';
import { isOfflineOnly } from '@shared/lib/store-mode';
import type { StoreStatus } from '@shared/lib/store-status';
import { PageContainer, POSButton } from '@shared/ui';

type Outcome = ConsoleLaunch | 'Failed';

function ActionButton({
  action,
  onRun,
  busy,
}: {
  action: ConsoleAction;
  onRun: (a: ConsoleAction) => void;
  busy: boolean;
}) {
  const { t } = useTranslation('pages');
  if (!isTauri()) return null;
  return (
    <POSButton
      type="button"
      variant="outline"
      disabled={busy}
      data-testid={`store-server-action-${action}`}
      onClick={() => {
        onRun(action);
      }}
    >
      {t(`storeServer.actions.${action}`)}
    </POSButton>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function StatusBody({
  status,
  onRun,
  busy,
}: {
  status: StoreStatus;
  onRun: (a: ConsoleAction) => void;
  busy: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tAdmin } = useTranslation('wAdmin');
  const age = statusAgeMs(status);
  const services = Object.entries(status.services ?? {});
  const db = status.database;
  const unfinished =
    status.state === 'provisioning' ||
    status.state === 'recovery-needed' ||
    status.alerts.some(a => a.code === 'RECOVERY_NEEDED');
  const backupLevel = status.backup?.alert ?? 'none';
  const actions = new Set<ConsoleAction>(['AddTill', 'ShowRecoveryKey']);
  if (unfinished) actions.add('ResumeSetup');
  return (
    <div
      className="space-y-6"
      data-testid="store-server-status"
      data-state={status.state ?? 'unknown'}
    >
      <p className="flex flex-wrap gap-x-3 text-sm" data-testid="store-server-summary">
        <span>
          {status.alerts.length === 0 && !unfinished
            ? t('storeServer.healthy')
            : t('storeServer.needsAttention')}
        </span>
        <span className="text-muted-foreground">
          {age === null
            ? t('storeServer.ageUnknown')
            : t('storeServer.age', { minutes: Math.max(0, Math.round(age / 60_000)) })}
        </span>
      </p>
      {unfinished && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {t('storeServer.setupUnfinished')}
        </p>
      )}
      <dl>
        {services.map(([name, s]) => (
          <Row key={name} label={`${t('storeServer.sections.services')}: ${name}`}>
            {s.healthy === true ? t('storeServer.serviceUp') : t('storeServer.serviceDown')}
          </Row>
        ))}
        <Row label={t('storeServer.sections.database')}>
          {db?.applied != null && db.expected?.applied != null
            ? t('storeServer.databaseLevel', { applied: db.applied, expected: db.expected.applied })
            : t('storeServer.unknown')}
        </Row>
        <Row label={t('storeServer.sections.pack')}>
          {status.packVersion ?? t('storeServer.unknown')}
        </Row>
        <Row label={t('storeServer.sections.network')}>
          {status.network?.profile ?? t('storeServer.unknown')}
        </Row>
        <Row label={t('storeServer.sections.backup')}>
          {backupLevel === 'critical'
            ? t('storeServer.backupCritical')
            : backupLevel === 'warn'
              ? t('storeServer.backupWarn')
              : t('storeServer.backupOk')}
        </Row>
      </dl>
      <section aria-label={t('storeServer.sections.alerts')}>
        <h2 className="mb-2 text-sm font-semibold">{t('storeServer.sections.alerts')}</h2>
        {status.alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('storeServer.noAlerts')}</p>
        ) : (
          <ul className="space-y-2">
            {status.alerts.map(a => {
              const info = alertInfo(a.code);
              const text = tAdmin(`storeServer.alerts.${a.code}`, {
                defaultValue: t('storeServer.genericAlert', { code: a.code }),
              });
              return (
                <li
                  key={`${a.code}-${a.since ?? ''}`}
                  data-testid={`store-server-alert-${a.code}`}
                  data-level={a.level}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>{text}</span>
                  {info.action && <ActionButton action={info.action} onRun={onRun} busy={busy} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        {[...actions].map(a => (
          <ActionButton key={a} action={a} onRun={onRun} busy={busy} />
        ))}
      </div>
    </div>
  );
}

export default function StoreServerPage() {
  const { t } = useTranslation('pages');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [joined, setJoined] = useState(false);
  const offline = isOfflineOnly();
  const query = useStoreStatus({ enabled: offline });

  const run = (action: ConsoleAction): void => {
    setBusy(true);
    void openPosctlConsole(action).then(r => {
      setBusy(false);
      const result: Outcome = r.ok ? r.data : 'Failed';
      setOutcome(result);
      if (action === 'JoinServer' && result === 'Launched') setJoined(true);
    });
  };

  return (
    <PageContainer title={t('storeServer.title')} description={t('storeServer.subtitle')}>
      {!offline ? (
        <div className="space-y-4" data-testid="store-server-cloud">
          <h2 className="text-lg font-semibold">{t('storeServer.cloudTitle')}</h2>
          <p className="text-sm">{t('storeServer.cloudBody')}</p>
          <div className="flex flex-wrap gap-2">
            <ActionButton action="SetUpServer" onRun={run} busy={busy} />
            <ActionButton action="JoinServer" onRun={run} busy={busy} />
          </div>
        </div>
      ) : query.isPending ? (
        <p className="text-sm">{t('storeServer.checking')}</p>
      ) : query.data?.ok ? (
        <StatusBody status={query.data.data} onRun={run} busy={busy} />
      ) : (
        <p
          role="alert"
          className="text-sm font-semibold text-destructive"
          data-testid="store-server-unreachable"
        >
          {t('storeServer.unreachable')}
        </p>
      )}
      {offline && (
        <POSButton
          type="button"
          variant="ghost"
          className="mt-4"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('storeServer.checkAgain')}
        </POSButton>
      )}
      {outcome && (
        <p
          role="status"
          className="mt-4 text-sm"
          data-testid="store-server-outcome"
          data-outcome={outcome}
        >
          {t(`storeServer.outcome.${outcome}`)}
        </p>
      )}
      {joined && (
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span>{t('storeServer.relaunchHint')}</span>
          <POSButton
            type="button"
            onClick={() => {
              void relaunch();
            }}
          >
            {t('storeServer.relaunch')}
          </POSButton>
        </div>
      )}
    </PageContainer>
  );
}

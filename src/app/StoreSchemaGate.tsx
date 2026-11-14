import { ServerCog } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isBlocking, type BlockingState } from '@shared/lib/store-schema/classify';
import { getExpectedSchema } from '@shared/lib/store-schema/expected';
import { useStoreSchemaPolling, useStoreSchemaStore } from '@shared/lib/store-schema/store';
import { useUpdaterStore, type UpdateCheckOutcome } from '@shared/lib/useAppUpdater';
import { Button } from '@shared/ui';
import { useInertBodySiblings } from './useInertBodySiblings';

interface Props {
  children: ReactNode;
}

const NONE = '—';

/** `available` shows no message: the global UpdateAvailableDialog opens and asks to install. */
const OUTCOME_MESSAGE: Record<UpdateCheckOutcome, string | null> = {
  available: null,
  none: 'storeSchema.updateNone',
  deferred: 'storeSchema.updateWaiting',
  error: 'storeSchema.updateError',
  skipped: 'storeSchema.updateSkipped',
};

/**
 * Full-screen overlay for Offline-only mode when the store server is at a different schema level
 * than this build (strict equality, conventions Q14). Writes are already refused by
 * licenseGuardedFetch; this screen says why and what to do. Cloud mode and every non-blocking
 * verdict (ok, unreachable, updating) show no overlay. The app stays mounted underneath, inert (same as
 * StoreSwitchGate), so a mid-sale mismatch does not destroy router, lock provider or page state.
 * Sibling of LicenseGate, mounted inside the same providers.
 */
export function StoreSchemaGate({ children }: Props) {
  const state = useStoreSchemaStore(s => s.state);
  // Mounted inside AppConfigProvider, so the store mode is known when the polling effect first runs.
  useStoreSchemaPolling();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const blocked = isBlocking(state);
  // Same inert + key-swallow + focus handling as StoreSwitchGate (focuses the first button, Try again).
  useInertBodySiblings(blocked ? host : null, state.kind);

  return (
    <>
      <div inert={blocked} aria-hidden={blocked ? true : undefined} className="contents">
        {children}
      </div>
      {isBlocking(state) ? createPortal(<SchemaOverlay state={state} setHost={setHost} />, document.body) : null}
    </>
  );
}

function SchemaOverlay({ state, setHost }: { state: BlockingState; setHost: (el: HTMLElement | null) => void }) {
  const refresh = useStoreSchemaStore(s => s.refresh);
  const { t } = useTranslation('common');
  // The message belongs to the blocking kind it was produced under; a different kind (or recovery) hides it.
  const [update, setUpdate] = useState<{ kind: string; message: string | null } | null>(null);
  const want = getExpectedSchema();
  const serverLevel = state.server ? `${state.server.maxVersion} / ${String(state.server.applied)}` : NONE;
  const clientLevel = `${want.maxVersion} / ${String(want.applied)}`;

  return (
    <div
      ref={setHost}
      tabIndex={-1}
      data-gate-overlay=""
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-background p-6 outline-none"
      data-testid="store-schema-gate"
      data-kind={state.kind}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="store-schema-title"
        className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-card p-8 shadow-lg">
        <header className="flex items-center gap-3">
          <span className="rounded-full bg-primary/10 p-2 text-primary">
            <ServerCog size={22} aria-hidden="true" />
          </span>
          <h1 id="store-schema-title" className="text-xl font-semibold">{t('storeSchema.title')}</h1>
        </header>
        <p className="text-sm text-foreground/90">
          {t(
            state.kind === 'client-outdated'
              ? 'storeSchema.clientOutdated'
              : state.kind === 'server-outdated'
                ? 'storeSchema.serverOutdated'
                : state.kind === 'inconsistent'
                  ? 'storeSchema.inconsistent'
                  : 'storeSchema.missing'
          )}
        </p>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p data-testid="store-schema-server-level">{t('storeSchema.serverLevel', { level: serverLevel })}</p>
          <p data-testid="store-schema-client-level">{t('storeSchema.clientLevel', { level: clientLevel })}</p>
        </div>
        <Button
          onClick={() => {
            void refresh();
          }}
        >
          {t('storeSchema.retry')}
        </Button>
        {state.kind === 'client-outdated' && (
        <Button
          variant="outline"
          className="ml-2"
          onClick={() => {
            void useUpdaterStore
              .getState()
              .checkForUpdates()
              .then(outcome => {
                setUpdate({ kind: state.kind, message: OUTCOME_MESSAGE[outcome] });
              });
          }}
        >
          {t('storeSchema.updateNow')}
        </Button>
        )}
        {update?.kind === state.kind && update.message && (
          <p className="text-xs text-muted-foreground" role="status" data-testid="store-schema-update-message">
            {t(update.message)}
          </p>
        )}
      </section>
    </div>
  );
}

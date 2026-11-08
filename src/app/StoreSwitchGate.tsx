import { ServerCog } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOfflineSaleStore } from '@entities/offline-sale/model/store';
import { useTabStore } from '@entities/tab/model/store';
import { getTerminalName } from '@shared/lib/license/terminal-id';
import { useStoreSwitchStore } from '@shared/lib/store-switch/store';
import { useStoreSwitchState } from '@shared/lib/store-switch/useStoreSwitchState';
import { Button } from '@shared/ui';

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

/**
 * Radix dialogs (and toasts, banners) portal into document.body, outside the gate's own wrapper, so while the overlay
 * is up every other body child is made inert. A late arrival (a portal mounted after the block began) is caught by the
 * observer. `inert` does not stop key events reaching window-level listeners (Enter in a ConfirmDialog, F1 help, the
 * barcode scanner, PIN keypad), so one capture listener swallows every key (no preventDefault:
 * Enter/Space/Tab are default actions on the Try again button, which stopPropagation does not block). Focus goes to the gate's button (or the gate itself) last, after the inert
 * pass, so a Radix focus trap that fought us cannot leave it on body.
 * ponytail: an `inert` removed by its owner while gated is not re-applied; a Radix modal opening under the gate sets
 * aria-hidden on the gate. Upgrade to a focus-scope library only if either shows up in practice.
 */
function useInertBodySiblings(host: HTMLElement | null, state: string): void {
  useEffect(() => {
    if (host === null) return;
    const touched = new Set<Element>();
    const apply = (): void => {
      for (const el of Array.from(document.body.children)) {
        if (el === host || touched.has(el) || el.hasAttribute('inert')) continue;
        el.setAttribute('inert', '');
        touched.add(el);
      }
    };
    const swallow = (e: Event): void => {
      e.stopPropagation(); // every key, the gate's button included: the gate has no key handlers of its own
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true });
    KEY_EVENTS.forEach(t => {
      window.addEventListener(t, swallow, true);
    });
    (host.querySelector('button') ?? host).focus();
    return () => {
      observer.disconnect();
      KEY_EVENTS.forEach(t => {
        window.removeEventListener(t, swallow, true);
      });
      touched.forEach(el => {
        el.removeAttribute('inert');
      });
    };
  }, [host, state]);
}

interface Props {
  children: ReactNode;
}

/**
 * While the cloud store is being moved (draining, frozen) or has moved, a blocking screen sits on top of the app.
 * The app stays mounted underneath, inert, so a sale in progress is not destroyed and the offline queue keeps flushing
 * (the queue processor and the till report live in Providers, outside this gate). Unknown state (offline, an older
 * backend without the view) never blocks anything. This is also what mounts the state poll (`useStoreSwitchState`).
 */
export function StoreSwitchGate({ children }: Props) {
  const { state, recheck } = useStoreSwitchState();
  const { t } = useTranslation('common');
  // Same notion of "unsent" as the till report: tab queue plus offline sales still waiting to reach the server.
  const queued =
    useTabStore(s => s.offlineQueue.length) +
    useOfflineSaleStore(
      s => s.records.filter(x => x.status === 'queued' || x.status === 'replaying').length
    );
  const blocked = state !== 'active';
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [stillMoved, setStillMoved] = useState(false);
  useInertBodySiblings(blocked ? host : null, state);
  useEffect(() => {
    setStillMoved(false);
  }, [state]);
  // disabled drops focus to body: hand it back when a recheck ends (not on first mount, the inert effect owns that).
  const retryRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) retryRef.current?.focus();
    wasPending.current = pending;
  }, [pending]);
  const tryAgain = async (): Promise<void> => {
    setPending(true);
    setStillMoved(false);
    try {
      await recheck();
    } finally {
      setPending(false);
    }
    setStillMoved(useStoreSwitchStore.getState().state === 'moved');
  };

  return (
    <>
      <div inert={blocked} aria-hidden={blocked ? true : undefined} className="contents">
        {children}
      </div>
      {blocked
        ? createPortal(
            <div
              ref={setHost}
              tabIndex={-1}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="store-switch-title"
              aria-describedby="store-switch-body"
              className="pointer-events-auto fixed inset-0 z-[100] flex outline-none items-center justify-center bg-background p-6"
            >
              <div className="max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-lg">
                <ServerCog
                  className="mx-auto mb-4 size-10 text-muted-foreground"
                  aria-hidden="true"
                />
                {state === 'moved' ? (
                  <>
                    <h1 id="store-switch-title" className="text-2xl font-semibold">
                      {t('storeSwitch.moved.title')}
                    </h1>
                    <p id="store-switch-body" className="mt-3 text-muted-foreground">
                      {t('storeSwitch.moved.body')}
                    </p>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {t('storeSwitch.moved.terminal', { label: getTerminalName() })}
                    </p>
                    {queued > 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('storeSwitch.moved.queue', { count: queued })}
                      </p>
                    ) : null}
                    <Button
                      className="mt-6"
                      size="lg"
                      ref={retryRef}
                      disabled={pending}
                      onClick={() => {
                        void tryAgain();
                      }}
                    >
                      {t('storeSwitch.moved.recheck')}
                    </Button>
                    {stillMoved ? (
                      <p role="status" className="mt-3 text-sm text-destructive">
                        {t('storeSwitch.moved.stillMoved')}
                      </p>
                    ) : null}
                  </>
                ) : state === 'frozen' ? (
                  <>
                    <h1 id="store-switch-title" className="text-2xl font-semibold">
                      {t('storeSwitch.frozen.title')}
                    </h1>
                    <p id="store-switch-body" className="mt-3 text-muted-foreground">
                      {t('storeSwitch.frozen.body')}
                    </p>
                  </>
                ) : (
                  <>
                    <h1 id="store-switch-title" className="text-2xl font-semibold">
                      {t('storeSwitch.draining.title')}
                    </h1>
                    <p id="store-switch-body" className="mt-3 text-muted-foreground">
                      {t('storeSwitch.draining.body')}
                    </p>
                    <p className="mt-3 text-sm font-medium">
                      {t('storeSwitch.draining.pending', { count: queued })}
                    </p>
                  </>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CartItem, CheckoutDraft } from '@shared/lib/domain';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@shared/ui/alert-dialog';
import { Button } from '@shared/ui/button';
import type { RecoveryView } from '../model/submissionRecovery';
import { RestoredValueReview } from './RestoredValueReview';

export interface PaymentRecoveryProps {
  view: RecoveryView;
  /** A status query is running: Retry is disabled so a double click sends one query. */
  checking: boolean;
  onRetry: () => void;
  onContinue: () => void;
  /** Saved basket shown under the status (UI-SPEC: persistent summary). Saved values only, never the key. */
  items: ReadonlyArray<CartItem>;
  totalCents: number;
  draft: CheckoutDraft | null;
}

/**
 * D-07/D-10: blocking status screen after a payment was sent and never answered. No Escape or outside close,
 * no close control, no Pay, edit or Discard. Unknown offers only Retry Status Check; Incomplete only Continue
 * (fires once). A completed sale renders nothing here: the panel moves on to the receipt. No key text anywhere.
 */
export function PaymentRecovery({ view, checking, onRetry, onContinue, items, totalCents, draft }: PaymentRecoveryProps) {
  const { t } = useTranslation('wPanels');
  const [continued, setContinued] = useState(false);
  if (view.kind === 'completed') return null;

  const title =
    view.kind === 'incomplete'
      ? t('paymentRecovery.incompleteTitle')
      : view.kind === 'unknown'
        ? t('paymentRecovery.unknownTitle')
        : t('paymentRecovery.checkingTitle');
  const body =
    view.kind === 'incomplete'
      ? t('paymentRecovery.incompleteBody')
      : view.kind === 'unknown'
        ? t('paymentRecovery.unknownBody')
        : t('paymentRecovery.checkingBody');
  const showSpinner = view.kind === 'checking' || view.kind === 'reconciling' || (view.kind === 'unknown' && checking);

  return (
    <AlertDialog open>
      <AlertDialogContent
        data-testid="payment-recovery"
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
        onEscapeKeyDown={event => {
          event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div role="status" aria-live="polite" aria-busy={showSpinner}>
              {body}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RestoredValueReview items={items} totalCents={totalCents} draft={draft} />
        <AlertDialogFooter>
          {view.kind === 'unknown' && (
            <Button variant="default" disabled={checking} onClick={onRetry}>
              {checking ? t('paymentRecovery.retrying') : t('paymentRecovery.retry')}
            </Button>
          )}
          {view.kind === 'incomplete' && (
            <Button
              variant="default"
              disabled={continued}
              onClick={() => {
                setContinued(true);
                onContinue();
              }}
            >
              {t('paymentRecovery.continue')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

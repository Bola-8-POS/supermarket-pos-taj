import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { PaymentForm, type PaymentFormProps } from '@widgets/PaymentModal/ui/PaymentForm';
import type { RecoveryView } from '@features/resume-sale/model/submissionRecovery';
import { useSubmissionRecovery } from '@features/resume-sale/model/useSubmissionRecovery';
import { PaymentRecovery } from '@features/resume-sale/ui/PaymentRecovery';
import { fetchReceiptDataForPayment, paymentReceiptKeys } from '@entities/payment';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CartItem, CheckoutDraft, SubmissionMarker } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger';

export interface SubmissionRecoveryGateProps extends Pick<PaymentFormProps, 'tab' | 'staffId' | 'processors'> {
  marker: SubmissionMarker;
  items: ReadonlyArray<CartItem>;
  totalCents: number;
  draft: CheckoutDraft | null;
  /** Receipt Done: the sale is finished, so cart, key, checkout and marker are all cleared. */
  onDone: () => void;
  /** Leaves recovery for the selling gate (the caller's useSavedSale.resolveRecovery). */
  onResolved: () => void;
}

/**
 * CART-04 recovery side (D-07..D-10). Renders only the recovery screen, so no cart or payment control exists
 * while a sent payment is unresolved. Outcomes:
 * - completed: the existing receipt opens (PaymentForm initialReceipt, never printed here);
 * - incomplete (not found after the settle window): the draft and the ORIGINAL key stay in the cart store, the
 *   marker is cleared and the cashier presses Pay; nothing is sent here;
 * - checking / reconciling / unknown (lookup or receipt read failed, offline): blocked, Retry Status Check only.
 */
export function SubmissionRecoveryGate({
  marker,
  items,
  totalCents,
  draft,
  tab,
  staffId,
  processors,
  onDone,
  onResolved,
}: SubmissionRecoveryGateProps) {
  const lookup = useSubmissionRecovery(marker);
  const completed = lookup.view.kind === 'completed' ? lookup.view : null;
  const receipt = useQuery({
    queryKey: paymentReceiptKeys.byTab(completed?.tabId ?? ''),
    queryFn: () => fetchReceiptDataForPayment(completed?.tabId ?? ''),
    enabled: completed !== null,
    retry: false,
    networkMode: 'always',
  });
  const receiptFailed = completed !== null && receipt.isError;
  useEffect(() => {
    if (receiptFailed) logger.warn('payment.recovery.receipt_failed', {});
  }, [receiptFailed]);

  if (completed !== null && receipt.data) {
    return (
      <PaymentForm
        tab={tab}
        staffId={staffId}
        {...(processors ? { processors } : {})}
        initialReceipt={receipt.data}
        onPaymentSuccess={() => undefined}
        onDone={onDone}
        onClose={onDone}
      />
    );
  }

  let view: RecoveryView = lookup.view;
  if (completed !== null) view = receiptFailed ? { kind: 'unknown' } : { kind: 'checking' };
  const retry = receiptFailed
    ? () => {
        if (!receipt.isFetching) void receipt.refetch();
      }
    : lookup.retryStatusCheck;

  const onContinue = () => {
    const store = useCartStore.getState();
    if (store.pendingIdempotencyKey !== marker.key) logger.warn('payment.recovery.pending_key_mismatch', {});
    // D-03 review applies to a restored sale (prices may have moved since); the original key is already the
    // cart's pending key, so Pay resends it while the basket is unchanged.
    store.setRestoredSnapshotLineIds(store.items.map(item => item.tempId));
    store.clearSubmission();
    store.openCheckout();
    onResolved();
  };

  return (
    <PaymentRecovery
      view={view}
      checking={lookup.isChecking || receipt.isFetching}
      onRetry={retry}
      onContinue={onContinue}
      items={items}
      totalCents={totalCents}
      draft={draft}
    />
  );
}

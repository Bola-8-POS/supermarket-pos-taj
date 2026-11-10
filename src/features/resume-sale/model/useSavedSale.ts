import { useCallback, useEffect, useState } from 'react';
import { useCajaStore, useCurrentCaja } from '@entities/caja';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CheckoutDraft, SubmissionMarker } from '@shared/lib/domain';

/** Phase 30 gate order: caja, submission marker (recovery), open Checkout (resume), selling. */
export type SavedSaleGate =
  | { state: 'loading' }
  | { state: 'selling' }
  | { state: 'recovery'; marker: SubmissionMarker }
  | { state: 'resume'; draft: CheckoutDraft | null };

export type SavedSale = SavedSaleGate & {
  resolveResume: () => void;
  resolveDiscard: () => void;
  resolveRecovery: () => void;
};

/**
 * Caja rung of the saved-sale gate. A sale belongs to one caja session on this terminal:
 * - a null owner is stamped with the open caja once there are lines;
 * - a cart owned by a caja the server confirms is not the open one (closed, or another) is purged.
 * An errored current-caja query never purges; only a cached caja that is open counts.
 * Marker rung: a persisted submission marker (a payment was sent and never answered) blocks everything else
 * until resolveRecovery() (30-04); it outranks the Resume dialog.
 * Checkout rung: once per mount, after the caja rung settles, a cart with its Checkout open asks the
 * cashier to Resume or Discard before anything is shown. Both mark the lines on screen as restored
 * (D-03 conflict check); Discard also drops the Checkout draft and open marker, keeping the cart.
 */
export function useSavedSale(): SavedSale {
  const caja = useCurrentCaja();
  const cachedCaja = useCajaStore(s => s.currentCaja);
  const owner = useCartStore(s => s.ownerCajaSessionId);
  const hasItems = useCartStore(s => s.items.length > 0);
  const clearCart = useCartStore(s => s.clearCart);
  const setOwner = useCartStore(s => s.setOwnerCajaSessionId);
  const checkout = useCartStore(s => s.checkout);
  const submission = useCartStore(s => s.submission);
  const [phase, setPhase] = useState<'pending' | 'recovery' | 'resume' | 'done'>('pending');

  const confirmed = caja.isSuccess && !caja.resultError;
  const settled = confirmed || caja.isError || caja.resultError !== undefined;
  const confirmedCajaId = caja.data?.status === 'open' ? caja.data.id : null;
  const cachedOpenId = cachedCaja?.status === 'open' ? cachedCaja.id : null;
  const openCajaId = confirmed ? confirmedCajaId : cachedOpenId;

  useEffect(() => {
    if (!settled) return;
    if (owner !== null && confirmed && owner !== openCajaId) {
      clearCart();
    } else if (owner === null && hasItems && openCajaId !== null) {
      setOwner(openCajaId);
    }
    if (phase === 'pending') {
      // Read after the purge above: a purged cart has nothing to resume.
      const { items, checkout: saved, submission: marker } = useCartStore.getState();
      const hasLines = items.length > 0;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot decision once the caja rung settles
      setPhase(hasLines && marker !== null ? 'recovery' : hasLines && saved?.open === true ? 'resume' : 'done');
    }
  }, [settled, confirmed, owner, openCajaId, hasItems, clearCart, setOwner, phase]);

  const markRestored = () => {
    const { items, setRestoredSnapshotLineIds } = useCartStore.getState();
    setRestoredSnapshotLineIds(items.map(item => item.tempId));
  };
  const resolveResume = useCallback(() => {
    markRestored();
    setPhase('done');
  }, []);
  const resolveDiscard = useCallback(() => {
    markRestored();
    useCartStore.getState().clearCheckout();
    setPhase('done');
  }, []);

  const resolveRecovery = useCallback(() => {
    setPhase('done');
  }, []);

  const resolvers = { resolveResume, resolveDiscard, resolveRecovery };
  if (!settled || phase === 'pending') return { state: 'loading', ...resolvers };
  if (phase === 'recovery' && submission !== null) return { state: 'recovery', marker: submission, ...resolvers };
  // 30-review H2: a marker with no open Checkout (Cancel after an unanswered payment) is unresolved evidence of a
  // possible sale; the till goes back to recovery instead of letting the cart be edited and paid under a new key.
  if (phase === 'done' && hasItems && submission !== null && checkout?.open !== true) {
    return { state: 'recovery', marker: submission, ...resolvers };
  }
  if (phase === 'resume') return { state: 'resume', draft: checkout?.draft ?? null, ...resolvers };
  return { state: 'selling', ...resolvers };
}

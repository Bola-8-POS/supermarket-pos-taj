import { useState } from 'react';
import { useCajaStore } from '@entities/caja';
import {
  buildProvisionalReceipt,
  classifyReplayResult,
  checkOfflineSaleLimits,
  completeReRing,
  computeSaleIntegrity,
  evaluateOfflineEligibility,
  provisionalReceiptNumber,
  sameGoods,
  useOfflineSaleStore,
  type OfflineEligibilityInput,
  type OfflineSale,
} from '@entities/offline-sale';
import { useStaffStore } from '@entities/staff';
import { calcWeightedLineTotal, useCartStore } from '@entities/tab/model/cartStore';
import { looksLikeCardNumber } from '@shared/lib/card-number';
import { isOnline } from '@shared/lib/connectivity';
import type { CartItem, GeneralSettings, PaymentMethod, Tab } from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
import {
  callProcessDirectSale,
  type ProcessDirectSaleRequest,
  type ProcessDirectSaleSuccess,
  type ReceiptData,
} from '@shared/lib/edge-function-contracts';
import i18n from '@shared/lib/i18n';
import { useInstanceRole } from '@shared/lib/instance-lock';
import {
  currentLicenseEvaluation,
  getEffectiveNow,
  requiresRevalidation,
} from '@shared/lib/license/store';
import { logger } from '@shared/lib/logger-instance';
import type { DiscountInfo, SplitPaymentLegInput } from '@shared/lib/payment-processor';
import { err, networkOfflineError, ok, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';
import { getTerminalId } from '@shared/lib/terminal';
import type { OfflineRefusalReason } from './offlineReasons';

const placeholderId = () => crypto.randomUUID();

/** Exported so the pricing-parity integration test builds the same tab the payment form totals. */
export function cartItemsToSyntheticTab(
  items: CartItem[],
  staffId: string,
  shiftId: string,
  tabId: string
): Tab {
  const orderId = placeholderId();
  return {
    id: tabId,
    customerName: i18n.t('featOrders:checkoutSale.defaultCustomerName'),
    staffId,
    shiftId,
    openedAt: new Date(),
    closedAt: null,
    status: 'open',
    notes: null,
    orders: [],
    items: items.map(item => ({
      id: item.tempId,
      orderId,
      productId: item.product.id,
      quantity: item.quantity,
      unitPrice: item.weightGrams != null ? item.lineTotal : item.unitPrice,
      weightGrams: item.weightGrams ?? null,
      modifierIds: item.selectedModifiers.map(modifier => modifier.id),
      modifierPriceDelta: item.selectedModifiers.reduce(
        (sum, modifier) => sum + modifier.priceDelta,
        0
      ),
      notes: item.notes || null,
      product: item.product,
      modifiers: item.selectedModifiers,
      lineTotal: item.lineTotal,
    })),
    subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0),
    rappiOrderId: undefined,
    cajaSessionId: null,
    version: 0,
  };
}

/** Exported for useCheckoutSale.test.ts to build fingerprints identical to submit()'s own. */
export function cartItemsToRpcItems(items: CartItem[]) {
  return items.map(item => ({
    productId: item.product.id,
    quantity: item.quantity,
    // process_direct_sale_atomic's PRICE_MISMATCH check validates unit_price
    // against the product's own undiscounted catalog price (products.base_price,
    // weight-adjusted for soldByWeight items) — never the cart's live-discounted
    // display price (PROMO-03 is display-only; the RPC independently recomputes
    // and applies any qualifying promotion server-side, Plan 27-01). Submitting
    // item.unitPrice/lineTotal here once they can hold a discounted value would
    // make every promoted-item checkout fail PRICE_MISMATCH.
    unitPrice:
      item.weightGrams != null
        ? calcWeightedLineTotal(item.product.basePrice, item.weightGrams)
        : item.product.basePrice,
    modifierIds: item.selectedModifiers.map(modifier => modifier.id),
    modifierPriceDelta: item.selectedModifiers.reduce(
      (sum, modifier) => sum + modifier.priceDelta,
      0
    ),
    notes: item.notes || null,
    weightGrams: item.weightGrams ?? undefined,
  }));
}

/**
 * Deterministic snapshot of exactly what determines this sale's items/totals
 * — the same fields `submit()` below sends to `callProcessDirectSale` for
 * `items`, plus the ad-hoc/custom discount (offline-first Plan 01, Task 6).
 * `useCheckoutSale` mints a fresh idempotency key whenever this fingerprint
 * no longer matches the one a persisted key was minted for, and reuses the
 * persisted key otherwise (including after an app restart) — necessary
 * because `process_direct_sale_atomic` replays a known key unconditionally,
 * without ever comparing items/totals against the original call
 * (supabase/migrations/20260913000002_combo_sale_pricing.sql:97-113), so the
 * client is the only place that can catch "same key, different cart".
 *
 * Deliberately excludes payment method/tendered amount/split legs/expected
 * total (tender mechanics, not sale content — changing only how the same
 * sale is paid must keep reusing the key) and the approval ticket
 * id/approver id (authorization audit metadata, not sale content). Line
 * order is not meaningful, so lines are sorted by a content key before
 * serializing.
 */
export function computeSaleFingerprint(
  rpcItems: ReturnType<typeof cartItemsToRpcItems>,
  discountInfo: DiscountInfo | undefined
): string {
  const lines = rpcItems
    .map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      weightGrams: item.weightGrams ?? null,
      unitPrice: item.unitPrice,
      modifierIds: [...item.modifierIds].sort(),
      modifierPriceDelta: item.modifierPriceDelta,
    }))
    .sort((a, b) =>
      `${a.productId}|${a.modifierIds.join(',')}|${String(a.weightGrams)}`.localeCompare(
        `${b.productId}|${b.modifierIds.join(',')}|${String(b.weightGrams)}`
      )
    );
  const discount = discountInfo
    ? {
        scope: discountInfo.scope,
        type: discountInfo.type,
        value: discountInfo.value,
        amount: discountInfo.amount,
        managerOverride: discountInfo.managerOverride,
      }
    : null;
  return JSON.stringify({ lines, discount });
}

/** Display snapshot of the cart lines, index-aligned with `cartItemsToRpcItems` (same items, same order). */
function cartItemsToSaleLines(items: CartItem[]) {
  return items.map(item => ({
    productId: item.product.id,
    name: item.product.name,
    categoryName: item.product.category?.name ?? null,
    modifierNames: item.selectedModifiers.map(modifier => modifier.name),
  }));
}

type DirectSalePayment = {
  method?: PaymentMethod;
  amount?: number;
  tenderedAmount?: number;
  referenceNumber?: string;
  legs?: {
    method: Exclude<PaymentMethod, 'bank_transfer'>;
    amount: number;
    tenderedAmount?: number;
    referenceNumber?: string;
  }[];
  expectedTotal?: number;
  discountInfo?: DiscountInfo | undefined;
  idempotencyKeyOverride?: string;
  customerName?: string;
  customerPhone?: string;
  /** Go straight to the offline branch even though the backend looks reachable ("Sell offline instead"). */
  sellOffline?: boolean;
};

/** Trailing argument of the cash / card / split processors: store the sale on this till instead of sending it. */
type SellOfflineOption = { sellOffline?: boolean };

/** What the checkout screen knows about a sale before it is submitted: enough to ask "can this be rung offline?". */
export type OfflineSaleProbe = Partial<
  Pick<OfflineEligibilityInput, 'method' | 'legs' | 'referenceNumber'>
> & {
  hasDiscount: boolean;
  hasOverride: boolean;
};

/** The only place the request body is built: the online and the offline path both send exactly this. */
function buildDirectSaleRequest(
  rpcItems: ReturnType<typeof cartItemsToRpcItems>,
  sale: { shiftId: string; cajaSessionId: string; idempotencyKey: string },
  payment: DirectSalePayment
): ProcessDirectSaleRequest {
  return {
    items: rpcItems,
    shiftId: sale.shiftId,
    cajaSessionId: sale.cajaSessionId,
    idempotencyKey: sale.idempotencyKey,
    terminalId: getTerminalId(),
    ...(payment.method ? { method: payment.method } : {}),
    ...(payment.amount !== undefined ? { amount: payment.amount } : {}),
    ...(payment.tenderedAmount !== undefined ? { tenderedAmount: payment.tenderedAmount } : {}),
    ...(payment.referenceNumber ? { referenceNumber: payment.referenceNumber } : {}),
    ...(payment.legs ? { legs: payment.legs } : {}),
    ...(payment.expectedTotal !== undefined ? { expectedTotal: payment.expectedTotal } : {}),
    ...(payment.discountInfo
      ? {
          discountScope: payment.discountInfo.scope,
          discountType: payment.discountInfo.type,
          discountValue: payment.discountInfo.value,
          discountAmount: payment.discountInfo.amount,
          managerOverride: payment.discountInfo.managerOverride,
          approvalId: payment.discountInfo.approvalId,
          approverId: payment.discountInfo.approverId,
        }
      : {}),
    ...(payment.customerName ? { customerName: payment.customerName } : {}),
    ...(payment.customerPhone ? { customerPhone: payment.customerPhone } : {}),
  };
}

/**
 * The key for this cart: the persisted one when it was minted for exactly this
 * cart content (fingerprint match), a fresh one otherwise.
 *
 * Read the persisted pair imperatively via getState() rather than a
 * render-time selector (opus re-review, Finding I on Task 6/M-3): two
 * submit() calls issued before React re-renders (e.g. a double-click that
 * slips past the isProcessing guard) would otherwise both close over the same
 * stale selector value and each mint a *different* fresh key. getState() sees
 * the write the first call already made synchronously (zustand's set() applies
 * immediately), so the second call reuses it instead of minting a second one
 * for the same attempt.
 *
 * Reuse the persisted key only when it was minted for this exact cart content
 * (fingerprint match) — a restart with an untouched cart, or a same-cart retry
 * within one session. Any cart edit since the key was minted (different
 * fingerprint) must mint a fresh key instead of resending a stale one
 * process_direct_sale_atomic would otherwise replay against the wrong sale (see
 * computeSaleFingerprint's doc).
 *
 * payment.idempotencyKeyOverride is deliberately IGNORED by callers (final
 * review, Finding 1): PaymentForm mints its own idempotencyKeyRef fresh on
 * every mount and passes it as this override on every processor call, for the
 * shared tab-payment path (PaymentProcessors is also used by
 * src/shared/lib/payment-processor.ts's process_payment_atomic flow, which does
 * need it). Letting that override win here would mean an app restart
 * mid-checkout mints a brand-new key and resends it — exactly the "RPC
 * committed, response lost, app killed" replay this fingerprint-bound key
 * exists to prevent. The parameter stays in the processor signatures below only
 * because they share PaymentProcessors' type with that other path.
 */
/**
 * Refusal codes that PROVE no sale exists under the key sent: process_direct_sale_atomic
 * (supabase/migrations/20261017000008_direct_sale_rering_already_paid.sql) answers each of them AFTER its
 * idempotency-key lookup (lines 94-109), so a sale committed under this key would have been replayed instead.
 * Lines: OFFLINE_SALE_WRITTEN_OFF 129, OFFLINE_SALE_ALREADY_CLOSED 133, RERING_ALREADY_PAID 144 (re-ring guards),
 * INVALID_ITEMS 112, INVALID_METHOD 117, RERING_NOT_APPROVED 123/138, PIN_LOCKED 158,
 * DISCOUNT_REQUIRES_MANAGER 171, INVALID_DISCOUNT_SCOPE 174, INVALID_DISCOUNT_PARAMS 184,
 * PRICE_MISMATCH 224/238, WEIGHT_OUT_OF_RANGE 230/233, BELOW_COST_REQUIRES_OVERRIDE 319/524,
 * MODIFIER_MISMATCH 334, AMOUNT_MISMATCH + ZERO_TOTAL_SALE 599-610 (rolled-back exceptions), INVENTORY_NEGATIVE.
 * NEVER listed: IDEMPOTENCY_UNAUTHORIZED (102, proves the sale EXISTS) and CAJA_CLOSED (76/79), SHIFT_NOT_OPEN (83),
 * FORBIDDEN (90, also 161) which are checked BEFORE the lookup and say nothing about an earlier send.
 */
const NO_SALE_UNDER_KEY_CODES: ReadonlySet<string> = new Set([
  'INVALID_ITEMS',
  'INVALID_METHOD',
  'RERING_NOT_APPROVED',
  'OFFLINE_SALE_WRITTEN_OFF',
  'OFFLINE_SALE_ALREADY_CLOSED',
  'RERING_ALREADY_PAID',
  'PIN_LOCKED',
  'DISCOUNT_REQUIRES_MANAGER',
  'INVALID_DISCOUNT_SCOPE',
  'INVALID_DISCOUNT_PARAMS',
  'PRICE_MISMATCH',
  'WEIGHT_OUT_OF_RANGE',
  'BELOW_COST_REQUIRES_OVERRIDE',
  'MODIFIER_MISMATCH',
  'AMOUNT_MISMATCH',
  'ZERO_TOTAL_SALE',
  'INVENTORY_NEGATIVE',
]);

/** The edge code the server answered with: the `<CODE>:` prefix of `details` (see replay-outcome.ts), never message text. */
function edgeCodeOf(error: AppError): string | undefined {
  if (error.code === 'INVENTORY_NEGATIVE') return 'INVENTORY_NEGATIVE';
  const details = (error.details ?? '').replace(/^DIRECT_SALE_FAILED: /, '');
  const match = /^([A-Z][A-Z_]+):/.exec(details);
  return match?.[1];
}

function provesNoSaleUnderKey(error: AppError): boolean {
  const code = edgeCodeOf(error);
  return code !== undefined && NO_SALE_UNDER_KEY_CODES.has(code);
}

function resolveIdempotencyKey(fingerprint: string): string {
  const {
    pendingIdempotencyKey: persistedIdempotencyKey,
    pendingIdempotencyFingerprint: persistedIdempotencyFingerprint,
    setPendingIdempotencyKey,
    reRing,
  } = useCartStore.getState();
  // A re-ring's key carries the offline sale id: that is how the server recognises the payment as this
  // sale's re-ring (resolve_offline_sale, 02c Ruling 9). A key minted under another prefix is not reused.
  // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefixes, not UI copy
  const prefix = reRing ? `rering_${reRing.saleId}` : 'direct_sale';
  const idempotencyKey =
    persistedIdempotencyKey !== null &&
    persistedIdempotencyFingerprint === fingerprint &&
    (!reRing || persistedIdempotencyKey.startsWith(`${prefix}_`))
      ? persistedIdempotencyKey
      : generateIdempotencyKey(prefix);
  if (idempotencyKey !== persistedIdempotencyKey || fingerprint !== persistedIdempotencyFingerprint) {
    setPendingIdempotencyKey(idempotencyKey, fingerprint);
  }
  return idempotencyKey;
}

/**
 * Result of `submit`. `provisional: true` means the sale was stored on this till
 * (no server sale exists yet): `receiptData` is the provisional receipt and
 * `saleId` the local record id. A server answer is passed through untouched.
 */
type SubmitData =
  | (ProcessDirectSaleSuccess & { provisional: false })
  | {
      provisional: true;
      receiptData: ReceiptData;
      saleId: string;
      // no server sale yet, so none of the ids a server success carries
      paymentId?: undefined;
      paymentGroupId?: undefined;
      paymentIds?: undefined;
    };

// Settings that could not be read must not stop a sale being stored; the slip is
// still marked PROVISIONAL and carries the sale itself.
const UNKNOWN_STORE = { storeName: '', address: '' };

/**
 * @param store Store name and address for the provisional receipt (the checkout
 * panel passes `useSettings().data.general`).
 * @param nearExpiryListUsable False when no near-expiry list covers the current threshold; an
 * offline sale is then refused as `revalidation` rather than priced without the tier.
 */
export function useCheckoutSale(
  store?: Pick<GeneralSettings, 'storeName' | 'address'>,
  nearExpiryListUsable: boolean = true
) {
  const items = useCartStore(state => state.items);
  const staff = useStaffStore(state => state.currentStaff);
  const shift = useStaffStore(state => state.currentShift);
  const caja = useCajaStore(state => state.currentCaja);
  const isCajaOpen = useCajaStore(state => state.isCajaOpen);
  const instanceRole = useInstanceRole();
  const [tabId] = useState(placeholderId);
  // Set when a re-rung sale succeeded but its offline record could not be closed; the screen shows it.
  const [reRingCompletionError, setReRingCompletionError] = useState<AppError | null>(null);
  const syntheticTab = cartItemsToSyntheticTab(
    items,
    staff?.id ?? tabId,
    shift?.id ?? tabId,
    tabId
  );

  // Staff, shift and caja all come from persisted stores (staff-store, caja), so
  // they survive a reload while offline; `ready` is null unless every one is there.
  const ready = staff && shift && caja && isCajaOpen ? { staff, shift, caja } : null;

  /** The refusal reason, or null when the sale may be rung offline (Rulings 2, 3, 13, 15, 16). */
  const offlineRefusal = (sale: OfflineSaleProbe): OfflineRefusalReason | null => {
    const limit = checkOfflineSaleLimits(useOfflineSaleStore.getState().records, getEffectiveNow());
    const eligibility = evaluateOfflineEligibility({
      method: sale.method,
      legs: sale.legs,
      referenceNumber: sale.referenceNumber,
      hasDiscount: sale.hasDiscount,
      hasOverride: sale.hasOverride,
      // A re-ring is the online replacement of a sale that is already on this till: a provisional copy would be a second sale.
      isReRing: Boolean(useCartStore.getState().reRing),
      instanceRole,
      licenseState: currentLicenseEvaluation().state,
      // An offline till whose near-expiry list cannot cover the current threshold would price the tier wrong (R57/D6): same outcome as a stale license.
      requiresRevalidation: requiresRevalidation() || !nearExpiryListUsable,
      isCajaOpen: ready !== null,
      limit,
    });
    if (eligibility.ok) return null;
    return eligibility.reason === 'limit' && !limit.ok ? `limit_${limit.reason}` : eligibility.reason;
  };

  const canSellOffline = (sale: OfflineSaleProbe): boolean => offlineRefusal(sale) === null;

  /** Today's NETWORK_OFFLINE, message unchanged, with the reason in `details` for the screen to read. */
  const refuseOffline = (reason: string) =>
    err<AppError>({ ...networkOfflineError(), details: reason });

  /**
   * Stores the sale on this till and hands back a provisional receipt. Order is
   * the safety property: eligibility -> limits -> request -> key -> integrity ->
   * PERSIST -> receipt. Nothing is shown before the record is stored; if it cannot
   * be stored the cart and its key stay exactly as they were.
   */
  const submitOffline = async (
    payment: DirectSalePayment
  ): Promise<Result<SubmitData, AppError>> => {
    // Everything up to and including the enqueue can throw (WebCrypto, storage, a
    // store read). A rejection here would leave the payment form stuck on
    // "processing", so it becomes an error result with the cart and key untouched.
    let saved: Result<OfflineSale>;
    // Defence in depth (the form refuses it first): a card number must never reach storage, the
    // printed slip or the server as an "approval reference".
    if (
      looksLikeCardNumber(payment.referenceNumber ?? '') ||
      payment.legs?.some(leg => looksLikeCardNumber(leg.referenceNumber ?? ''))
    ) {
      return err({
        code: 'VALIDATION_ERROR',
        message: i18n.t('featOrders:checkoutSale.cardNumberAsReference'),
      });
    }
    try {
      const refusal = offlineRefusal({
        method: payment.method,
        legs: payment.legs,
        referenceNumber: payment.referenceNumber,
        hasDiscount: payment.discountInfo !== undefined,
        hasOverride:
          payment.discountInfo?.managerOverride === true ||
          payment.discountInfo?.approvalId !== undefined,
      });
      if (refusal !== null) return refuseOffline(refusal);
      // eslint-disable-next-line i18next/no-literal-string -- machine-readable refusal reason, not UI copy
      if (ready === null) return refuseOffline('no_open_caja');

      const rpcItems = cartItemsToRpcItems(items);
      const idempotencyKey = resolveIdempotencyKey(
        computeSaleFingerprint(rpcItems, payment.discountInfo)
      );
      const request = buildDirectSaleRequest(
        rpcItems,
        { shiftId: ready.shift.id, cajaSessionId: ready.caja.id, idempotencyKey },
        payment
      );
      const id = crypto.randomUUID();
      const soldAt = new Date(getEffectiveNow()).toISOString();
      const receiptNumber = provisionalReceiptNumber(id);
      const integrity = await computeSaleIntegrity(request, soldAt, receiptNumber);

      saved = useOfflineSaleStore.getState().enqueueOfflineSale({
        id,
        request,
        lines: cartItemsToSaleLines(items),
        soldAt,
        staffId: ready.staff.id,
        staffName: ready.staff.name,
        receiptNumber,
        integrity,
      });
    } catch (error) {
      logger.error('offline_sale.prepare_failed', {}, error);
      return err({
        code: 'UNKNOWN_ERROR',
        message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
      });
    }
    if (!saved.ok) {
      // The store's own message is developer English; the cashier gets the catalog text.
      logger.error('offline_sale.enqueue_failed', { code: saved.error.code });
      return err({ code: saved.error.code, message: i18n.t('featOrders:checkoutSale.offlineSaveFailed') });
    }

    // Built from the STORED record (a repeated pay of the same cart gets the first
    // record back), so the slip always matches what will be replayed. Pure: nothing
    // from here on throws, so a stored sale is always reported as stored.
    if (!store) logger.warn('offline_sale.receipt_without_store', { saleId: saved.data.id });
    const receiptData = buildProvisionalReceipt(saved.data, store ?? UNKNOWN_STORE);
    // The cart's key is NOT released here: the cart lifecycle does that (clearCart on
    // Done; any cart edit changes the fingerprint and mints a new key), exactly as on
    // the online path. Until then a re-pay of the unchanged cart resolves the same
    // key and gets this record back instead of making a second sale.
    return ok({ provisional: true as const, receiptData, saleId: saved.data.id });
  };

  const submit = async (payment: DirectSalePayment): Promise<Result<SubmitData, AppError>> => {
    // an old completion error describes an old sale; it must not sit on this one
    setReRingCompletionError(null);
    // 30-review H2: a marker names a payment that may have committed. Only a resend of THAT key (same cart,
    // same fingerprint) may go out; anything else would mint a second key for the same basket. Nothing is sent
    // or minted, and the till is routed to the recovery screen (useSavedSale).
    const prior = useCartStore.getState().submission;
    if (prior !== null) {
      const cartState = useCartStore.getState();
      const priorFingerprint = computeSaleFingerprint(cartItemsToRpcItems(items), payment.discountInfo);
      if (cartState.pendingIdempotencyKey !== prior.key || cartState.pendingIdempotencyFingerprint !== priorFingerprint) {
        logger.warn('checkout.submit.blocked_unresolved_submission', {});
        return err({ code: 'PAYMENT_OUTCOME_UNKNOWN', message: i18n.t('featOrders:checkoutSale.submissionUnresolved') });
      }
    }
    if (payment.sellOffline === true || !isOnline()) {
      return submitOffline(payment);
    }
    // Checked after the offline guard so an offline terminal keeps its current behaviour.
    if (requiresRevalidation()) {
      return err({ code: 'LICENSE_ERROR', message: i18n.t('featOrders:checkoutSale.licenseRevalidating') });
    }
    if (!ready) {
      return err({ code: 'CAJA_CLOSED', message: i18n.t('entities:tab.cajaNotOpen') });
    }
    // The re-ring this payment belongs to is decided now, on the tick the request is built: the
    // cart can be cleared or refilled while the answer is on its way, and the answer must close
    // the record it was sent for, no other.
    const marker = useCartStore.getState().reRing;
    const rpcItems = cartItemsToRpcItems(items);
    // The manager approved re-ringing THIS sale's goods, not whatever is in the cart afterwards:
    // refused before anything is sent or minted, so the cashier can restore the lines or clear the cart.
    const fingerprint = computeSaleFingerprint(rpcItems, payment.discountInfo);
    let completedReRing: OfflineSale | undefined;
    if (marker) {
      const original = useOfflineSaleStore.getState().records.find(r => r.id === marker.saleId);
      const goodsMatch = original !== undefined && sameGoods(rpcItems, original.request.items);
      // R52: a re-ring that already completed (reload before Done) may be paid again ONLY as a replay of
      // the attempt that completed it: this cart still carries that attempt's pending key for these very
      // goods. The server then returns the recorded sale and `completeReRing` is a no-op. Anything else
      // must not ring the goods a second time, and says so.
      if (original?.status === 'resolved' && original.resolution === 'rering') {
        completedReRing = original;
        const cartState = useCartStore.getState();
        // D13: the pending key must also be one this record stored before sending. A record completed
        // before attempt keys existed has none, so it keeps the weaker cart-only proof. Either way it
        // must be the key `resolveIdempotencyKey` would send: one without this sale's prefix would be
        // replaced by a fresh key, and a "replay" under a fresh key is a new sale of goods already rung.
        const recorded = original.reRingAttemptKeys;
        const sameAttempt =
          cartState.pendingIdempotencyKey !== null &&
          cartState.pendingIdempotencyKey.startsWith(`rering_${marker.saleId}_`) &&
          cartState.pendingIdempotencyFingerprint === fingerprint &&
          (recorded.length === 0 || recorded.includes(cartState.pendingIdempotencyKey));
        if (!goodsMatch || !sameAttempt) {
          logger.warn('offline_sale.rering.already_completed', { saleId: marker.saleId, sameAttempt });
          return err({
            code: 'VALIDATION_ERROR',
            message: i18n.t('featOrders:reviewOfflineSales.reRingAlreadyCompleted'),
          });
        }
      } else if (original?.status !== 'needs_review' || !goodsMatch) {
        logger.warn('offline_sale.rering.cart_changed', {
          saleId: marker.saleId,
          recordStatus: original?.status ?? 'missing',
        });
        return err({
          code: 'VALIDATION_ERROR',
          message: i18n.t('featOrders:reviewOfflineSales.reRingCartChanged'),
        });
      }
    }
    // the server may already have written this sale off: a new sale would be counted twice
    if (marker && completedReRing === undefined) {
      const source = useOfflineSaleStore.getState().records.find(r => r.id === marker.saleId);
      if (source?.resolutionOutcomeUnknown) {
        return err({
          code: 'VALIDATION_ERROR',
          message: i18n.t('featOrders:reviewOfflineSales.reRingAfterLostWriteOff'),
        });
      }
    }
    const idempotencyKey = resolveIdempotencyKey(fingerprint);
    // D13: a re-ring attempt's key goes on the record BEFORE the request leaves the till, so a
    // restart or a cleared cart cannot hide a paid re-ring from the server pre-check. If it cannot
    // be stored, nothing is sent. (A completed re-ring replays under a key already recorded.)
    if (marker && completedReRing === undefined) {
      const stored = useOfflineSaleStore
        .getState()
        .applyEvent(marker.saleId, { type: 'reRingAttempted', key: idempotencyKey });
      if (!stored || stored.ignored || !stored.persisted) {
        logger.error('offline_sale.rering.attempt_key_not_stored', {
          saleId: marker.saleId,
          found: stored !== undefined,
        });
        return err({
          code: 'UNKNOWN_ERROR',
          message: i18n.t('featOrders:reviewOfflineSales.notStored'),
        });
      }
    }
    // Phase 30 (CART-04): the marker is stored BEFORE the request leaves the till, with the exact key sent,
    // so a crash mid-request leaves proof that a submission may have committed. Each retry rewrites it.
    useCartStore.getState().setSubmission({ key: idempotencyKey, startedAt: Date.now() });
    const saleRequest = buildDirectSaleRequest(
      rpcItems,
      { shiftId: ready.shift.id, cajaSessionId: ready.caja.id, idempotencyKey },
      payment
    );
    const result = await callProcessDirectSale(saleRequest);
    // Do NOT clear the persisted key here on success (opus re-review,
    // Finding I-1). The cart (and its pendingIdempotencyKey) survives until
    // the cashier taps Done on the receipt screen or otherwise resets the
    // cart (clearCart/holdCart/resumeHeld already null it there). If the
    // app is closed or the cashier navigates away before Done, the cart
    // reappears on the next render with the SAME key and fingerprint, so a
    // retry replays the original sale instead of charging it again.
    // Success keeps the marker until Done. A definitive refusal (a known no-commit) clears ONLY the marker; the key
    // stays under the existing fingerprint rule. Timeout, network, 5xx, abort and anything unclassified keep it.
    if (!result.ok && provesNoSaleUnderKey(result.error)) {
      useCartStore.getState().clearSubmission();
    }
    if (!result.ok) {
      // M1: the replay of a completed re-ring was REFUSED (tender flipped, another cashier or shift,
      // caja closed): the sale is recorded, so "payment failed" would be false. An unreachable or
      // unknown outcome is not a refusal and keeps its normal handling.
      if (completedReRing !== undefined) {
        const { event } = classifyReplayResult(completedReRing, result);
        const refused =
          event.type === 'refused' ||
          // eslint-disable-next-line i18next/no-literal-string -- the edge function's own code prefix, not UI copy
          (event.type === 'failedUnknown' && (result.error.details ?? '').startsWith('PAYMENT_FAILED:'));
        if (refused) {
          logger.warn('offline_sale.rering.replay_refused', {
            saleId: completedReRing.id,
            code: result.error.code,
          });
          return err({
            code: 'VALIDATION_ERROR',
            message: i18n.t('featOrders:reviewOfflineSales.reRingAlreadyCompleted'),
          });
        }
      }
      // 02d: the server holds a write-off of this sale, or a link to it (ALREADY_CLOSED). The record
      // stays in review and, like a lost write-off answer, closes Retry and Re-ring so only Write off
      // remains (it gets the stored answer back); only the `resolved` transition clears the flag.
      const refusedDetails = result.error.details ?? '';
      // eslint-disable-next-line i18next/no-literal-string -- the edge function's own code prefixes, not UI copy
      if (marker && (refusedDetails.startsWith('OFFLINE_SALE_WRITTEN_OFF:') || refusedDetails.startsWith('OFFLINE_SALE_ALREADY_CLOSED:') || refusedDetails.startsWith('RERING_ALREADY_PAID:'))) {
        const flagged = useOfflineSaleStore.getState().applyEvent(marker.saleId, { type: 'resolutionOutcomeUnknown' });
        // not stored (storage full): Retry and Re-ring stay open until the app reloads
        if (flagged && !flagged.persisted) logger.warn('offline_sale.rering.written_off_flag_not_stored', { saleId: marker.saleId });
      }
      return result;
    }

    // A re-rung cart: the new sale exists, so close the old record now. The sale stays a success
    // whatever happens here (the money moved); a record that could not be closed is surfaced
    // through `reRingCompletionError` and by the completion's own logging. Also runs when a lost
    // response is retried: the replayed success reaches this line too.
    if (marker) {
      const done = completeReRing(
        marker,
        result.data.tabId,
        // a success without a receipt carries no total; the paid total adds no "overpaid" claim
        result.data.receiptData?.total ?? marker.paidTotal
      );
      setReRingCompletionError(done.ok ? null : done.error);
    }
    return ok({ ...result.data, provisional: false as const });
  };

  return {
    syntheticTab,
    reRingCompletionError,
    processors: {
      /** Would this sale be stored on this till right now? Same rules `submit` applies offline. */
      canSellOffline,
      /** Why not: the reason `submit` would refuse with, or null when the sale could be stored. */
      offlineRefusal,
      processCashPayment: async (
        _tabId: string,
        amount: number,
        tenderedAmount: number,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string,
        options?: SellOfflineOption
      ) => {
        const result = await submit({
          method: 'cash',
          amount,
          tenderedAmount,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
          ...(options?.sellOffline ? { sellOffline: true } : {}),
        });
        // A provisional sale has no server payment: the local sale id stands in for it.
        if (result.ok && result.data.provisional) {
          return ok({
            paymentId: result.data.saleId,
            changeAmount: result.data.receiptData.changeAmount ?? 0,
            receiptData: result.data.receiptData,
          });
        }
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({
          paymentId: result.data.paymentId,
          changeAmount: result.data.receiptData.changeAmount ?? 0,
          receiptData: result.data.receiptData,
        });
      },
      processCardPayment: async (
        _tabId: string,
        amount: number,
        referenceNumber?: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string,
        options?: SellOfflineOption
      ) => {
        const result = await submit({
          method: 'card',
          amount,
          ...(referenceNumber ? { referenceNumber } : {}),
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
          ...(options?.sellOffline ? { sellOffline: true } : {}),
        });
        if (result.ok && result.data.provisional) {
          return ok({ paymentId: result.data.saleId, receiptData: result.data.receiptData });
        }
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({ paymentId: result.data.paymentId, receiptData: result.data.receiptData });
      },
      processBankTransferPayment: async (
        _tabId: string,
        amount: number,
        customerName: string,
        customerPhone: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method: 'bank_transfer',
          amount,
          customerName,
          customerPhone,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({
          paymentId: result.data.paymentId,
          referenceCode: result.data.receiptData.terminalReference ?? '',
          receiptData: result.data.receiptData,
        });
      },
      processPlatformPayment: async (
        _tabId: string,
        amount: number,
        method: 'rappi' | 'uber_eats',
        referenceNumber?: string,
        discountInfo?: DiscountInfo,
        _expectedVersion?: number,
        idempotencyKeyOverride?: string
      ) => {
        const result = await submit({
          method,
          amount,
          ...(referenceNumber ? { referenceNumber } : {}),
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
        });
        if (!result.ok || !result.data.paymentId || !result.data.receiptData)
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        return ok({ paymentId: result.data.paymentId, receiptData: result.data.receiptData });
      },
      processSplitPayment: async (
        _tabId: string,
        legs: SplitPaymentLegInput[],
        expectedTotal: number,
        discountInfo?: DiscountInfo,
        idempotencyKeyOverride?: string,
        options?: SellOfflineOption
      ) => {
        const result = await submit({
          legs,
          expectedTotal,
          ...(discountInfo ? { discountInfo } : {}),
          ...(idempotencyKeyOverride ? { idempotencyKeyOverride } : {}),
          ...(options?.sellOffline ? { sellOffline: true } : {}),
        });
        if (result.ok && result.data.provisional) {
          return ok({
            paymentGroupId: result.data.saleId,
            paymentIds: [],
            receipts: [result.data.receiptData],
          });
        }
        if (
          !result.ok ||
          !result.data.paymentGroupId ||
          !result.data.paymentIds ||
          !result.data.receiptData
        ) {
          return result.ok
            ? err({
                code: 'UNKNOWN_ERROR',
                message: i18n.t('featOrders:checkoutSale.paymentIncomplete'),
              })
            : result;
        }
        // process-direct-sale now returns one sale-level receiptData for a
        // split direct sale (basket composed once, every leg in
        // receiptData.tenders) rather than one receipt per leg. Wrap it as
        // a single-element array so PaymentForm's PaymentProcessors
        // contract — shared with the untouched generic tab split-payment
        // path, which still returns one receipt per leg (D-09) — stays
        // structurally unchanged.
        return ok({
          paymentGroupId: result.data.paymentGroupId,
          paymentIds: result.data.paymentIds,
          receipts: [result.data.receiptData],
        });
      },
    },
    // No resetIdempotencyKey here (opus re-review, Finding I-2): the cart
    // lifecycle (clearCart/holdCart/resumeHeld) is the sole owner of
    // clearing pendingIdempotencyKey. Cancelling the payment screen must
    // NOT clear it — the fingerprint already forces a fresh key on any real
    // cart edit, so an unedited retry after a lost response correctly
    // reuses the same key instead of double-charging.
  };
}

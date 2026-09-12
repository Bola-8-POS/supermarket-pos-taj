/**
 * PaymentForm — all payment state and UI extracted from PaymentModal.
 * Can be embedded inline (PaymentPane) or wrapped in a Dialog (PaymentModal).
 */

import { AlertCircle, Copy, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { ReceiptPreview } from '@features/process-payment/ui/ReceiptPreview';
import { evaluateBestPromotion, usePromotions } from '@entities/promotion';
import { useReceiptSettings, useSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import { calcWeightedLineTotal } from '@entities/tab/model/cartStore';
import type { Tab } from '@entities/tab/model/types';
import {
  PAYMENT_METHODS,
  ReceiptSettingsSchema,
  type DiscountType,
  type PaymentMethod,
} from '@shared/lib/domain';
import {
  getDiscountBase,
  calculateDiscountAmount,
  generateIdempotencyKey,
} from '@shared/lib/domain-helpers';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { formatMoney } from '@shared/lib/format';
import { groupOrderItems } from '@shared/lib/groupOrderItems';
import { logger } from '@shared/lib/logger-instance';
import {
  processCardPayment,
  processCashPayment,
  processPlatformPayment,
  processSplitPayment,
  type DiscountInfo,
  type SplitPaymentLegInput,
} from '@shared/lib/payment-processor';
import { openCashDrawer, printJobErrorCopyKey, printReceipt } from '@shared/lib/pos-printer';
import type { AppErrorCode, Result } from '@shared/lib/result';
import {
  ConfirmDialog,
  MoneyDisplay,
  MoneyInput,
  POSButton,
  ProtectedAction,
  ScrollArea,
  Switch,
} from '@shared/ui';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

type PayMethod = PaymentMethod;

// bank_transfer is checkout-time single-method only (no split-leg support
// this phase, see PLAN 23-02) — split rows keep the pre-existing method set.
type SplitPayMethod = Exclude<PayMethod, 'bank_transfer'>;

type SplitRow = {
  id: string;
  method: SplitPayMethod;
  amount: number;
  tenderedAmount: number;
  cardReference: string;
};

type SplitRowAction =
  | { type: 'RESET_ROWS'; rows: SplitRow[] }
  | { type: 'ADD_ROW'; defaultMethod: SplitPayMethod }
  | { type: 'REMOVE_ROW'; rowId: string }
  | { type: 'SET_METHOD'; rowId: string; method: SplitPayMethod }
  | { type: 'SET_AMOUNT'; rowId: string; value: number }
  | { type: 'SET_TENDERED'; rowId: string; value: number }
  | { type: 'SET_CARD_REF'; rowId: string; value: string };

let splitRowCounter = 0;
function nextSplitRowId(): string {
  splitRowCounter += 1;
  return `split-row-${String(splitRowCounter)}`;
}

function makeDefaultSplitRow(method: SplitPayMethod): SplitRow {
  return {
    id: nextSplitRowId(),
    method,
    amount: 0,
    tenderedAmount: 0,
    cardReference: '',
  };
}

function splitRowsReducer(state: SplitRow[], action: SplitRowAction): SplitRow[] {
  switch (action.type) {
    case 'RESET_ROWS':
      return action.rows;
    case 'ADD_ROW':
      if (state.length >= 4) return state;
      return [...state, makeDefaultSplitRow(action.defaultMethod)];
    case 'REMOVE_ROW':
      if (state.length <= 2) return state;
      return state.filter(r => r.id !== action.rowId);
    case 'SET_METHOD':
      return state.map(r => (r.id === action.rowId ? { ...r, method: action.method } : r));
    case 'SET_AMOUNT':
      return state.map(r => (r.id === action.rowId ? { ...r, amount: action.value } : r));
    case 'SET_TENDERED':
      return state.map(r => (r.id === action.rowId ? { ...r, tenderedAmount: action.value } : r));
    case 'SET_CARD_REF':
      return state.map(r => (r.id === action.rowId ? { ...r, cardReference: action.value } : r));
    default:
      return state;
  }
}

const DEFAULT_ENABLED_METHODS: Record<PaymentMethod, boolean> = {
  cash: true,
  card: true,
  bank_transfer: true,
  rappi: true,
  uber_eats: true,
};

/** Methods that never appear as split-payment legs (D-16/PLAN 23-02). */
const SPLIT_ELIGIBLE_METHODS = PAYMENT_METHODS.filter(
  (m): m is SplitPayMethod => m !== 'bank_transfer'
);
const DEFAULT_TAX_RATE_PERCENT = 16;
// Phase 28 (D-06): mirrors process_direct_sale_atomic's own
// COALESCE(..., 'America/Mexico_City') fallback when settings.general is
// unavailable — evaluateBestPromotion always needs a timezone argument.
const DEFAULT_TIMEZONE = 'America/Mexico_City';

// MXN cash notes offered as one-tap quick-tender amounts alongside the exact-total button.
const QUICK_TENDER_AMOUNTS = [100, 200, 500, 1000] as const;

export type PaymentProcessors = {
  processCashPayment: typeof processCashPayment;
  processCardPayment: typeof processCardPayment;
  processPlatformPayment: typeof processPlatformPayment;
  processSplitPayment: typeof processSplitPayment;
  /**
   * Only ever supplied by CheckoutPanel (via useCheckoutSale) — absent from
   * defaultProcessors, which PaymentPane's generic tab-payment flow uses.
   * This absence is the sole client-side gate implementing D-16's
   * "checkout-time only" scoping (T-23-06): PaymentForm only renders the
   * Bank Transfer method button when this field is present.
   */
  processBankTransferPayment?: (
    tabId: string,
    amount: number,
    customerName: string,
    customerPhone: string,
    discountInfo?: DiscountInfo,
    expectedVersion?: number,
    idempotencyKeyOverride?: string
  ) => ReturnType<typeof processCardPayment>;
};

const defaultProcessors: PaymentProcessors = {
  processCashPayment,
  processCardPayment,
  processPlatformPayment,
  processSplitPayment,
};

export interface PaymentFormProps {
  tab: Tab;
  /** Current staff profile id — required to process payment */
  staffId: string;
  onPaymentSuccess: () => void;
  /** Used by PaymentModal's Dialog to close after viewing receipt */
  onClose?: () => void;
  /** Used by direct sale checkout after a successful receipt is dismissed */
  onDone?: () => void;
  /** Storybook / tests */
  processors?: PaymentProcessors;
}

function calculateLineTotal(
  item: Pick<Tab['items'][number], 'unitPrice' | 'modifierPriceDelta' | 'quantity'>
): number {
  return (item.unitPrice + item.modifierPriceDelta) * item.quantity;
}

export function PaymentForm({
  tab,
  staffId,
  onPaymentSuccess,
  onClose,
  onDone,
  processors = defaultProcessors,
}: PaymentFormProps) {
  const { t } = useTranslation('wPanels');
  const { t: tCommon } = useTranslation('common');
  const currentRole = useStaffStore(s => s.currentStaff?.role);
  const { data: appSettings } = useSettings();
  const { data: receiptSettings } = useReceiptSettings();
  // Phase 27 (PROMO-05): resultError intentionally unread — a promotions
  // fetch failure never blocks payment (backstop truth); the "Apply
  // Promotion" section just stays hidden (activePromotionOptions is empty).
  const { data: allPromotions } = usePromotions();
  const settings = receiptSettings ?? ReceiptSettingsSchema.parse({});
  const enabledMethods = appSettings?.billing.paymentMethods ?? DEFAULT_ENABLED_METHODS;
  const taxRatePercent = appSettings?.billing.taxRatePercent ?? DEFAULT_TAX_RATE_PERCENT;
  const taxInclusive = appSettings?.billing.taxInclusive ?? true;
  const timezone = appSettings?.general.timezone ?? DEFAULT_TIMEZONE;
  const paymentLabels = appSettings?.paymentLabels ?? {
    cash: t('paymentForm.defaultLabelCash'),
    card: t('paymentForm.defaultLabelCard'),
    bank_transfer: t('paymentForm.defaultLabelBankTransfer'),
    rappi: t('paymentForm.defaultLabelRappi'),
    uber_eats: t('paymentForm.defaultLabelUberEats'),
  };

  const [step, setStep] = useState<'pay' | 'receipt'>('pay');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [tenderedAmount, setTenderedAmount] = useState(0);
  const [cardReference, setCardReference] = useState('');
  const [cardChargeOverride, setCardChargeOverride] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('percent');
  const [discountValue, setDiscountValue] = useState(0);
  const [discountExpanded, setDiscountExpanded] = useState(false);
  // Phase 27 (PROMO-05/07): managerOverride authorizes both the ad-hoc
  // discount (once the section is PIN-gated open) AND a below-cost
  // floor-guard retry — "one manager PIN entry covers the whole sale"
  // (D-07). pinPurpose tracks which flow requested the dialog so onSuccess
  // knows what to do next.
  const [managerOverride, setManagerOverride] = useState(false);
  // Phase 27 Plan 08 (G-27-13): the PIN of the staff member who actually
  // matched in ManagerPinDialog — threaded to the RPC so the server can
  // independently re-verify authorization against the entered PIN rather
  // than the currently logged-in staff's own identity. Reset everywhere
  // managerOverride resets to false, so a stale PIN from a prior payment
  // attempt is never reused.
  const [authorizingManagerPin, setAuthorizingManagerPin] = useState<string | undefined>(undefined);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinPurpose, setPinPurpose] = useState<'discount' | 'below_cost' | null>(null);
  // Phase 27 (PROMO-05): id of the "Apply Promotion" selection — independent
  // of discountType/discountValue (D-10, coexists, never overwrites).
  const [selectedPromotionId, setSelectedPromotionId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showOfflineDialog, setShowOfflineDialog] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [isSplitMode, setIsSplitMode] = useState(false);
  const [splitRows, dispatchSplitRows] = useReducer(splitRowsReducer, []);
  const idempotencyKeyRef = useRef<string | null>(null);

  // Single-method methods offered right now: enabled in settings, and (for
  // bank_transfer only) gated by processors.processBankTransferPayment being
  // supplied at all — the checkout-time-only scope (D-16).
  const availableMethods = useMemo(
    () =>
      PAYMENT_METHODS.filter(
        m =>
          enabledMethods[m] && (m !== 'bank_transfer' || Boolean(processors.processBankTransferPayment))
      ),
    [enabledMethods, processors.processBankTransferPayment]
  );
  // Split-payment legs never include bank_transfer (D-16/PLAN 23-02).
  const availableSplitMethods = useMemo(
    () => SPLIT_ELIGIBLE_METHODS.filter(m => enabledMethods[m]),
    [enabledMethods]
  );
  // Primitive deps for the reset effects below: `availableMethods` /
  // `availableSplitMethods` get a fresh array identity whenever the settings
  // query object or `processors` re-materialise (an offline/online observer
  // notification is enough), and keying a full form reset on that identity
  // wiped the tendered amount mid-checkout. Only the default method matters.
  const defaultMethod: PaymentMethod = availableMethods[0] ?? 'cash';
  const defaultSplitMethod: SplitPayMethod = availableSplitMethods[0] ?? 'cash';

  /* Reset state when the tab being viewed (or the default method) changes */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setStep('pay');
    setErrorMessage(null);
    setReceiptData(null);
    setMethod(defaultMethod);
    setTenderedAmount(0);
    setCardReference('');
    setCardChargeOverride(null);
    setCustomerName('');
    setCustomerPhone('');
    setDiscountType('percent');
    setDiscountValue(0);
    setDiscountExpanded(false);
    setManagerOverride(false);
    setAuthorizingManagerPin(undefined);
    setPinDialogOpen(false);
    setPinPurpose(null);
    setSelectedPromotionId(null);
    setIsSplitMode(false);
    idempotencyKeyRef.current = null;
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [tab.id, defaultMethod]);

  /* Split-mode rows: seed 2 default rows on toggle-ON, clear on toggle-OFF */
  useEffect(() => {
    if (isSplitMode) {
      dispatchSplitRows({
        type: 'RESET_ROWS',
        rows: [makeDefaultSplitRow(defaultSplitMethod), makeDefaultSplitRow(defaultSplitMethod)],
      });
    } else {
      dispatchSplitRows({ type: 'RESET_ROWS', rows: [] });
    }
  }, [isSplitMode, defaultSplitMethod]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!availableMethods.includes(method)) {
      setMethod(availableMethods[0] ?? 'cash');
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [availableMethods, method]);

  // Phase 27 (PROMO-05): promotions currently within their active date range
  // — same inclusive-boundary contract as the RPC's `now() BETWEEN starts_at
  // AND ends_at`. Empty list hides the "Apply Promotion" section entirely.
  const activePromotionOptions = useMemo(() => {
    const now = new Date();
    return (allPromotions ?? []).filter(p => p.active && now >= p.startsAt && now <= p.endsAt);
  }, [allPromotions]);
  const selectedPromotion = activePromotionOptions.find(p => p.id === selectedPromotionId) ?? null;

  // Re-evaluates every cart line against the manually-selected promotion,
  // never worsening a line that already resolved a better price at scan
  // time (PROMO-03) — reuses evaluateBestPromotion's own per-candidate money
  // formula (a single-promotion candidate array) rather than re-deriving it.
  const effectiveItems = useMemo(() => {
    if (!selectedPromotion) return tab.items;
    return tab.items.map(item => {
      if (!item.product) return item;
      const match = evaluateBestPromotion(
        {
          productId: item.product.id,
          categoryId: item.product.categoryId,
          basePrice: item.product.basePrice,
        },
        [selectedPromotion],
        new Date(),
        0,
        null,
        0,
        timezone
      );
      if (!match) return item;
      const candidateUnitPrice =
        item.weightGrams != null
          ? calcWeightedLineTotal(match.discountedUnitPrice, item.weightGrams)
          : match.discountedUnitPrice;
      // Lower price === bigger discount off the same fixed basePrice — this
      // is Math.max on discount amount expressed as Math.min on the
      // resulting price. Never worsen an already-better-discounted line.
      if (candidateUnitPrice >= item.unitPrice) return item;
      return { ...item, unitPrice: candidateUnitPrice };
    });
  }, [tab.items, selectedPromotion, timezone]);

  const itemsSubtotal = useMemo(
    () => effectiveItems.reduce((sum, item) => sum + calculateLineTotal(item), 0),
    [effectiveItems]
  );
  // Pool tables were removed (Phase 1 strip-rebrand) — pool charges are
  // permanently 0. DiscountScopeSchema's pool_only/consumptions_only members
  // were retired in Phase 27 (PROMO-05); 'all' is the only scope now.
  const poolChargesTotal = 0;
  const baseSubtotal = itemsSubtotal + poolChargesTotal;
  const discountBase = useMemo(
    () => getDiscountBase(itemsSubtotal, poolChargesTotal, 'all'),
    [itemsSubtotal]
  );
  const discountAmount = useMemo(
    () => calculateDiscountAmount(discountBase, discountType, discountValue),
    [discountBase, discountType, discountValue]
  );
  const afterDiscount = Math.round((baseSubtotal - discountAmount) * 100) / 100;
  const taxAmount = useMemo(() => {
    if (taxInclusive) {
      // Inclusive mode (TAX-02): afterDiscount already IS the total — decompose
      // subtotal by division first, then derive tax by subtraction (never
      // re-derive independently — avoids a 1-cent drift vs. the total).
      const decomposedSubtotal =
        Math.round((afterDiscount / (1 + taxRatePercent / 100)) * 100) / 100;
      return Math.round((afterDiscount - decomposedSubtotal) * 100) / 100;
    }
    // Exclusive mode (TAX-03): unchanged additive math.
    return Math.round(afterDiscount * (taxRatePercent / 100) * 100) / 100;
  }, [afterDiscount, taxRatePercent, taxInclusive]);
  const subtotalWithTax = taxInclusive
    ? afterDiscount
    : Math.round((afterDiscount + taxAmount) * 100) / 100;
  const runningTotal = subtotalWithTax;
  const changeDue = Math.max(0, Math.round((tenderedAmount - runningTotal) * 100) / 100);
  const effectiveCardAmount = cardChargeOverride ?? runningTotal;

  // card, rappi and uber_eats all charge a (possibly overridden) referenced
  // amount with no tendered/change concept (D-16: platform tenders behave
  // exactly like card).
  const isReferencedMethod = method === 'card' || method === 'rappi' || method === 'uber_eats';
  const canSubmitCash = tenderedAmount >= runningTotal && runningTotal > 0;
  const canSubmitCard = effectiveCardAmount > 0;
  const canSubmitBankTransfer = customerPhone.trim().length > 0;
  const canSubmit =
    staffId.length > 0 &&
    (method !== 'cash' || canSubmitCash) &&
    (!isReferencedMethod || canSubmitCard) &&
    (method !== 'bank_transfer' || canSubmitBankTransfer);

  const splitRowsSum = useMemo(
    () => Math.round(splitRows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    [splitRows]
  );
  const splitRemaining = Math.round((subtotalWithTax - splitRowsSum) * 100) / 100;

  const perRowMethodValid = (row: SplitRow): boolean => {
    if (row.method === 'cash') {
      return row.tenderedAmount >= row.amount;
    }
    return true;
  };

  const canSubmitSplit =
    staffId.length > 0 &&
    isSplitMode &&
    splitRows.length >= 2 &&
    splitRows.length <= 4 &&
    splitRows.every(r => r.amount > 0) &&
    Math.abs(splitRowsSum - subtotalWithTax) <= 0.01 &&
    splitRows.every(perRowMethodValid);

  const groupedItems = useMemo(() => groupOrderItems(effectiveItems), [effectiveItems]);

  const runPayment = async (
    /**
     * Overrides `managerOverride` state for this one attempt — passed
     * explicitly (rather than read from state) so a below-cost PIN retry
     * that fires `onSuccess` -> `setManagerOverride(true)` -> re-submit in
     * the same tick doesn't read the stale pre-update state value.
     */
    overrideManagerOverride?: boolean,
    /**
     * Mirrors `overrideManagerOverride` for the authorizing PIN (Phase 27
     * Plan 08, G-27-13) — same same-tick-stale-state problem: the below-cost
     * retry path calls `onSuccess` -> `setAuthorizingManagerPin(...)` ->
     * resubmit in the same tick, before React commits the new state.
     */
    overrideManagerPin?: string
  ): Promise<Result<{ receiptData: ReceiptData }, { message: string; code?: AppErrorCode }>> => {
    if (!staffId) {
      return { ok: false, error: { message: t('paymentForm.notSignedIn') } };
    }

    const effectiveManagerOverride = overrideManagerOverride ?? managerOverride;
    const effectiveManagerPin = overrideManagerPin ?? authorizingManagerPin;
    // Present whenever there's an ad-hoc discount OR a manager override is in
    // effect — the latter must reach the RPC even with discountAmount=0 (a
    // below-cost retry triggered purely by an auto-applied promotion, no
    // ad-hoc discount at all).
    const discountInfoArg =
      discountAmount > 0 || effectiveManagerOverride
        ? {
            // eslint-disable-next-line i18next/no-literal-string -- DiscountScope's sole enum member, not UI copy
            scope: 'all' as const,
            type: discountType,
            value: discountValue,
            amount: discountAmount,
            managerOverride: effectiveManagerOverride,
            managerPin: effectiveManagerPin,
          }
        : undefined;

    if (method === 'cash') {
      // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
      idempotencyKeyRef.current ??= generateIdempotencyKey('payment_cash');
      const r = await processors.processCashPayment(
        tab.id,
        subtotalWithTax,
        tenderedAmount,
        discountInfoArg,
        tab.version,
        idempotencyKeyRef.current
      );
      // r.error.code is typed as bare `string` by PaymentProcessors' legacy
      // AppError contract (supabase-contracts.ts), but the direct-sale
      // processors (useCheckoutSale.ts) actually populate it from the real
      // AppErrorCode union in result.ts — cast to check the offline code.
      if (!r.ok)
        return {
          ok: false,
          error: { message: r.error.message, code: r.error.code as AppErrorCode },
        };
      return { ok: true, data: { receiptData: r.data.receiptData } };
    }

    if (method === 'card' || method === 'rappi' || method === 'uber_eats') {
      // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
      idempotencyKeyRef.current ??= generateIdempotencyKey(`payment_${method}`);
      const ref = cardReference.trim();
      const chargeAmount = cardChargeOverride ?? subtotalWithTax;
      const r =
        method === 'card'
          ? await processors.processCardPayment(
              tab.id,
              chargeAmount,
              ref.length > 0 ? ref : undefined,
              discountInfoArg,
              tab.version,
              idempotencyKeyRef.current
            )
          : await processors.processPlatformPayment(
              tab.id,
              chargeAmount,
              method,
              ref.length > 0 ? ref : undefined,
              discountInfoArg,
              tab.version,
              idempotencyKeyRef.current
            );
      if (!r.ok)
        return {
          ok: false,
          error: { message: r.error.message, code: r.error.code as AppErrorCode },
        };
      return { ok: true, data: { receiptData: r.data.receiptData } };
    }

    // Exhaustive: cash / (card | rappi | uber_eats) / bank_transfer cover every
    // PaymentMethod — `method` is narrowed to exactly 'bank_transfer' here.
    if (!processors.processBankTransferPayment) {
      return {
        ok: false,
        error: { message: t('featOrders:checkoutSale.bankTransferUnavailable') },
      };
    }
    // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
    idempotencyKeyRef.current ??= generateIdempotencyKey('payment_bank_transfer');
    const name = customerName.trim() || t('featOrders:checkoutSale.defaultCustomerName');
    const r = await processors.processBankTransferPayment(
      tab.id,
      subtotalWithTax,
      name,
      customerPhone.trim(),
      discountInfoArg,
      tab.version,
      idempotencyKeyRef.current
    );
    if (!r.ok)
      return {
        ok: false,
        error: { message: r.error.message, code: r.error.code as AppErrorCode },
      };
    return { ok: true, data: { receiptData: r.data.receiptData } };
  };

  const handlePrimary = async (overrideManagerOverride?: boolean, overrideManagerPin?: string) => {
    setErrorMessage(null);
    setIsProcessing(true);
    const result = await runPayment(overrideManagerOverride, overrideManagerPin);
    setIsProcessing(false);

    if (!result.ok) {
      if (result.error.code === 'NETWORK_OFFLINE') {
        setShowOfflineDialog(true);
        return;
      }
      if (result.error.code === 'BELOW_COST_REQUIRES_OVERRIDE') {
        toast.error(t('featOrders:belowCostOverride.message'));
        setPinPurpose('below_cost');
        setPinDialogOpen(true);
        return;
      }
      setErrorMessage(result.error.message);
      logger.warn('payment.failed', {
        tabId: tab.id,
        code: result.error.code,
        message: result.error.message,
      });
      return;
    }

    logger.info('payment.succeeded', { tabId: tab.id, paymentMethod: method });
    idempotencyKeyRef.current = null;
    const receipt = result.data.receiptData;
    setReceiptData(receipt);
    setStep('receipt');
    onPaymentSuccess();

    void (async () => {
      const logHardwareFail = (event: string, code: AppErrorCode, message: string) => {
        logger.warn(event, { tabId: tab.id, message });
        toast.error(t(printJobErrorCopyKey(code)));
      };
      try {
        if (method === 'cash') {
          const drawer = await openCashDrawer(settings.printerName);
          if (!drawer.ok)
            logHardwareFail('cash_drawer.failed', drawer.error.code, drawer.error.message);
          const printed = await printReceipt(receipt, settings);
          if (!printed.ok)
            logHardwareFail('printer.receipt.failed', printed.error.code, printed.error.message);
        } else {
          const printed = await printReceipt(receipt, settings);
          if (!printed.ok)
            logHardwareFail('printer.receipt.failed', printed.error.code, printed.error.message);
        }
      } catch (e) {
        logger.warn('printer.post_payment.exception', { tabId: tab.id, raw: String(e) });
        toast.error(t('paymentForm.printOrDrawerFailed'));
      }
    })();
  };

  const handleSplitPrimary = async (
    overrideManagerOverride?: boolean,
    overrideManagerPin?: string
  ) => {
    setErrorMessage(null);
    setIsProcessing(true);

    const effectiveManagerOverride = overrideManagerOverride ?? managerOverride;
    const effectiveManagerPin = overrideManagerPin ?? authorizingManagerPin;
    const discountInfoArg =
      discountAmount > 0 || effectiveManagerOverride
        ? {
            // eslint-disable-next-line i18next/no-literal-string -- DiscountScope's sole enum member, not UI copy
            scope: 'all' as const,
            type: discountType,
            value: discountValue,
            amount: discountAmount,
            managerOverride: effectiveManagerOverride,
            managerPin: effectiveManagerPin,
          }
        : undefined;

    const legs: SplitPaymentLegInput[] = splitRows.map(row => ({
      method: row.method,
      amount: row.amount,
      ...(row.method === 'cash' ? { tenderedAmount: row.tenderedAmount } : {}),
      ...(row.method !== 'cash' && row.cardReference.trim().length > 0
        ? { referenceNumber: row.cardReference.trim() }
        : {}),
    }));

    // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
    idempotencyKeyRef.current ??= generateIdempotencyKey('payment_split');
    const result = await processors.processSplitPayment(
      tab.id,
      legs,
      subtotalWithTax,
      discountInfoArg,
      idempotencyKeyRef.current
    );
    setIsProcessing(false);

    if (!result.ok) {
      if (result.error.code === 'NETWORK_OFFLINE') {
        setShowOfflineDialog(true);
        return;
      }
      if (result.error.code === 'BELOW_COST_REQUIRES_OVERRIDE') {
        toast.error(t('featOrders:belowCostOverride.message'));
        setPinPurpose('below_cost');
        setPinDialogOpen(true);
        return;
      }
      setErrorMessage(t('paymentForm.splitPaymentFailed'));
      logger.warn('payment.split_failed', { tabId: tab.id, code: 'client' });
      return;
    }

    // Direct-sale split payments now return one sale-level receipt (basket
    // composed once, every leg in receiptData.tenders); the untouched
    // generic tab split-payment path (D-09) still returns one receipt per
    // leg — either way, the first receipt is what's shown on screen, and
    // every receipt in the array is still printed below.
    const firstReceipt = result.data.receipts[0];
    if (!firstReceipt) {
      setErrorMessage(t('paymentForm.splitPaymentFailed'));
      logger.warn('payment.split_failed', { tabId: tab.id, code: 'client' });
      return;
    }

    logger.info('payment.split_succeeded', { tabId: tab.id, legCount: legs.length });
    idempotencyKeyRef.current = null;
    setReceiptData(firstReceipt);
    setStep('receipt');
    onPaymentSuccess();

    void (async () => {
      const logHardwareFail = (event: string, code: AppErrorCode, message: string) => {
        logger.warn(event, { tabId: tab.id, message });
        toast.error(t(printJobErrorCopyKey(code)));
      };
      try {
        if (legs.some(l => l.method === 'cash')) {
          const drawer = await openCashDrawer(settings.printerName);
          if (!drawer.ok)
            logHardwareFail('cash_drawer.failed', drawer.error.code, drawer.error.message);
        }
        for (const receipt of result.data.receipts) {
          const printed = await printReceipt(receipt, settings);
          if (!printed.ok)
            logHardwareFail('printer.receipt.failed', printed.error.code, printed.error.message);
        }
      } catch (e) {
        logger.warn('printer.post_payment.exception', { tabId: tab.id, raw: String(e) });
        toast.error(t('paymentForm.printOrDrawerFailed'));
      }
    })();
  };

  const primaryLabel = isSplitMode
    ? t('paymentForm.processSplitPayment')
    : isReferencedMethod
      ? t('paymentForm.confirmCardPayment')
      : t('paymentForm.processPayment');

  const handleReceiptDone = () => {
    (onDone ?? onClose)?.();
  };

  if (step === 'receipt' && receiptData) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden p-4 sm:px-6">
        {receiptData.paymentMethod === 'bank_transfer' && receiptData.terminalReference && (
          <section
            className="mb-4 space-y-2 rounded-2xl border-2 border-success bg-success-soft p-5 text-center"
            data-testid="bank-transfer-reference-code-section"
          >
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('featOrders:checkoutSale.referenceCodeHeading')}
            </h3>
            <p
              className="font-mono text-4xl font-bold tracking-[0.2em] text-success-strong"
              data-testid="bank-transfer-reference-code"
            >
              {receiptData.terminalReference}
            </p>
            <POSButton
              type="button"
              variant="outline"
              touchSize="default"
              onClick={() => {
                void navigator.clipboard.writeText(receiptData.terminalReference ?? '');
                toast.success(t('featOrders:checkoutSale.codeCopied'));
              }}
            >
              <Copy className="mr-2 size-4" />
              {t('featOrders:checkoutSale.copyCode')}
            </POSButton>
            <p className="text-xs text-muted-foreground">
              {t('featOrders:checkoutSale.referenceCodeInstructions')}
            </p>
          </section>
        )}
        <ReceiptPreview
          receipt={receiptData}
          onDone={() => {
            handleReceiptDone();
          }}
        />
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="flex-1 p-4 sm:px-6">
        <div className="grid gap-5 pb-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
          <div className="order-1 space-y-5 lg:order-2 lg:sticky lg:top-0">
            <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
              <div>
                <h3 className="text-lg font-semibold tracking-tight">{tab.customerName}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('paymentForm.itemTypesAndTotal', {
                    itemTypeCount: groupedItems.length,
                    plural: groupedItems.length !== 1 ? 's' : '',
                    itemCount: tab.items.reduce((s, i) => s + i.quantity, 0),
                  })}
                </p>
              </div>
              <div className="space-y-2">
                {groupedItems.map(item => (
                  <div
                    key={`${item.productId}::${item.modifierIds.join(',')}`}
                    className="flex items-start justify-between gap-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {item.quantity > 1 ? `${String(item.quantity)}× ` : ''}
                        {item.productName}
                      </p>
                      {item.discountAmount > 0 && (
                        <p
                          className="text-xs font-medium text-success-strong"
                          data-testid="line-item-discount-badge"
                        >
                          {item.discountRate != null
                            ? t('paymentForm.lineItemDiscountRate', { rate: item.discountRate })
                            : t('paymentForm.lineItemDiscountAmount', {
                                amount: formatMoney(item.discountAmount),
                              })}
                        </p>
                      )}
                    </div>
                    <MoneyDisplay amount={item.lineTotal} size="sm" />
                  </div>
                ))}
                <div className="flex justify-between border-t border-border pt-2 font-semibold">
                  <span>{t('paymentForm.itemsSubtotal')}</span>
                  <MoneyDisplay amount={itemsSubtotal} size="sm" />
                </div>
              </div>
            </section>

            {processors.processBankTransferPayment && activePromotionOptions.length > 0 && (
                <section
                  className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs"
                  data-testid="apply-promotion-section"
                >
                  <Label htmlFor="apply-promotion-select" className="text-sm font-semibold">
                    {t('featOrders:applyPromotion.label')}
                  </Label>
                  <Select
                    value={selectedPromotionId ?? ''}
                    onValueChange={value => {
                      setSelectedPromotionId(value);
                    }}
                  >
                    <SelectTrigger
                      id="apply-promotion-select"
                      data-testid="apply-promotion-select"
                      disabled={isProcessing}
                    >
                      <SelectValue placeholder={t('featOrders:applyPromotion.placeholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {activePromotionOptions.map(promo => (
                        <SelectItem key={promo.id} value={promo.id}>
                          {promo.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </section>
              )}

            <section
              className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs"
              data-testid="discount-section"
            >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <Label htmlFor="discount-toggle" className="text-sm font-semibold">
                      {t('paymentForm.discount')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('paymentForm.discountDescription')}
                    </p>
                  </div>
                  <Switch
                    id="discount-toggle"
                    checked={discountExpanded}
                    disabled={isProcessing}
                    onCheckedChange={checked => {
                      if (checked) {
                        // Phase 27 (PROMO-05): expanding the ad-hoc discount
                        // section now requires a manager PIN first — the
                        // Switch itself stays visually off until onSuccess
                        // flips discountExpanded (a fresh PIN entry is
                        // required every time the section is re-expanded).
                        setPinPurpose('discount');
                        setPinDialogOpen(true);
                      } else {
                        setDiscountExpanded(false);
                        setManagerOverride(false);
                        setAuthorizingManagerPin(undefined);
                      }
                    }}
                  />
                </div>
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${
                    discountExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="space-y-2 pt-2">
                      <div className="flex gap-2">
                        {/* Phase 27 (PROMO-05): pool_only/consumptions_only scopes retired —
                            'all' is DiscountScope's only remaining member, so this is a
                            non-interactive label rather than a scope picker. */}
                        <div
                          data-testid="discount-scope-all"
                          className="flex-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-center text-xs font-medium text-muted-foreground"
                        >
                          {t('paymentForm.discountScopeAll')}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {/* eslint-disable-next-line i18next/no-literal-string -- fixed discount-type enum identifiers, not UI copy */}
                        {(['percent', 'fixed'] as const).map(type => (
                          <POSButton
                            key={type}
                            type="button"
                            touchSize="large"
                            variant={discountType === type ? 'default' : 'outline'}
                            disabled={isProcessing}
                            data-testid={`discount-type-${type}`}
                            onClick={() => {
                              setDiscountType(type);
                            }}
                            className="flex-1"
                          >
                            {type === 'percent'
                              ? t('paymentForm.discountTypePercent')
                              : t('paymentForm.discountTypeFixed')}
                          </POSButton>
                        ))}
                      </div>
                      <MoneyInput
                        label={
                          discountType === 'percent'
                            ? t('paymentForm.discountPercentLabel')
                            : t('paymentForm.discountAmountLabel')
                        }
                        value={discountValue}
                        onChange={setDiscountValue}
                        disabled={isProcessing}
                        data-testid="discount-value-input"
                      />
                      {discountAmount > 0 && (
                        <p
                          className="text-sm font-medium text-success-strong"
                          data-testid="discount-applied-label"
                        >
                          {t('paymentForm.discountApplied', {
                            amount: formatMoney(discountAmount),
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </section>

            <section className="space-y-2 rounded-xl border border-border bg-muted/40 p-4">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{t('paymentForm.subtotal')}</span>
                <MoneyDisplay amount={baseSubtotal} size="sm" />
              </div>
              {discountAmount > 0 && (
                <>
                  <div
                    className="flex items-center justify-between text-sm font-medium text-success-strong"
                    data-testid="discount-row"
                  >
                    <span>
                      {t('paymentForm.discountRow', {
                        detail:
                          discountType === 'percent'
                            ? `${String(discountValue)}%`
                            : t('paymentForm.discountRowFixed'),
                      })}
                    </span>
                    <span>
                      -<MoneyDisplay amount={discountAmount} size="sm" />
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span>{t('paymentForm.afterDiscount')}</span>
                    <MoneyDisplay amount={afterDiscount} size="sm" />
                  </div>
                </>
              )}
              <div
                className="flex items-center justify-between text-sm text-muted-foreground"
                data-testid="tax-row"
              >
                <span>{t('paymentForm.taxLabel', { rate: taxRatePercent })}</span>
                <MoneyDisplay amount={taxAmount} size="sm" />
              </div>
              <div
                className="flex items-center justify-between border-t border-border pt-3 text-lg font-semibold"
                data-testid="total-row"
              >
                <span>{t('paymentForm.total')}</span>
                <MoneyDisplay amount={runningTotal} size="xl" />
              </div>
            </section>
          </div>
          <div className="order-2 space-y-5 lg:order-1">
            <section className="space-y-3">
              <h4 className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t('paymentForm.paymentMethod')}
              </h4>

              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-4 shadow-xs">
                <div>
                  <Label htmlFor="split-mode-toggle" className="text-sm font-semibold">
                    {t('paymentForm.splitPayment')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('paymentForm.splitPaymentDescription')}
                  </p>
                </div>
                <Switch
                  id="split-mode-toggle"
                  checked={isSplitMode}
                  disabled={isProcessing}
                  onCheckedChange={setIsSplitMode}
                />
              </div>

              {isSplitMode ? (
                <div className="space-y-3">
                  {splitRows.map((row, index) => (
                    <div
                      key={row.id}
                      className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          {t('paymentForm.paymentNumber', { number: index + 1 })}
                        </span>
                        {splitRows.length > 2 && (
                          <POSButton
                            type="button"
                            variant="ghost"
                            touchSize="xl"
                            focusEmphasis="high"
                            aria-label={`Remove payment ${String(index + 1)}`}
                            disabled={isProcessing}
                            className="px-2 text-destructive"
                            onClick={() => {
                              dispatchSplitRows({ type: 'REMOVE_ROW', rowId: row.id });
                            }}
                          >
                            <Trash2 className="size-4" />
                          </POSButton>
                        )}
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        {availableSplitMethods.map(m => (
                          <POSButton
                            key={m}
                            type="button"
                            touchSize="large"
                            variant={row.method === m ? 'default' : 'outline'}
                            disabled={isProcessing}
                            data-testid={`split-payment-btn-${m.replace('_', '-')}`}
                            onClick={() => {
                              dispatchSplitRows({
                                type: 'SET_METHOD',
                                rowId: row.id,
                                method: m,
                              });
                            }}
                          >
                            {paymentLabels[m]}
                          </POSButton>
                        ))}
                      </div>

                      <MoneyInput
                        label={t('paymentForm.amount')}
                        value={row.amount}
                        onChange={value => {
                          dispatchSplitRows({ type: 'SET_AMOUNT', rowId: row.id, value });
                        }}
                        disabled={isProcessing}
                      />

                      {row.method === 'cash' && (
                        <>
                          <MoneyInput
                            label={t('paymentForm.amountTendered')}
                            value={row.tenderedAmount}
                            onChange={value => {
                              dispatchSplitRows({ type: 'SET_TENDERED', rowId: row.id, value });
                            }}
                            disabled={isProcessing}
                          />
                          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm font-medium">
                            <span>{t('paymentForm.changeDue')}</span>
                            <MoneyDisplay
                              amount={Math.max(
                                0,
                                Math.round((row.tenderedAmount - row.amount) * 100) / 100
                              )}
                              size="sm"
                            />
                          </div>
                        </>
                      )}

                      {row.method !== 'cash' && (
                        <div className="space-y-2">
                          <Label htmlFor={`split-card-ref-${row.id}`}>
                            {t('paymentForm.referenceOptional')}
                          </Label>
                          <Input
                            id={`split-card-ref-${row.id}`}
                            value={row.cardReference}
                            onChange={e => {
                              dispatchSplitRows({
                                type: 'SET_CARD_REF',
                                rowId: row.id,
                                value: e.target.value,
                              });
                            }}
                            placeholder={t('paymentForm.terminalReceiptPlaceholder')}
                            maxLength={64}
                            disabled={isProcessing}
                            autoComplete="off"
                          />
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground">
                        {t('paymentForm.splitRowCharges', {
                          amount: formatMoney(row.amount),
                        })}
                      </p>
                    </div>
                  ))}

                  <POSButton
                    type="button"
                    variant="outline"
                    disabled={isProcessing || splitRows.length >= 4}
                    onClick={() => {
                      dispatchSplitRows({
                        type: 'ADD_ROW',
                        defaultMethod: availableSplitMethods[0] ?? 'cash',
                      });
                    }}
                  >
                    {t('paymentForm.addPaymentMethod')}
                  </POSButton>

                  <div
                    className={`rounded-xl border p-4 ${
                      splitRemaining === 0
                        ? 'border-success bg-success-soft'
                        : 'border-border bg-card'
                    }`}
                  >
                    <div className="flex items-center justify-between text-sm font-semibold">
                      <span>
                        {splitRemaining > 0
                          ? t('paymentForm.remainingToPay')
                          : splitRemaining === 0
                            ? t('paymentForm.fullyAllocated')
                            : t('paymentForm.overBy', {
                                amount: formatMoney(Math.abs(splitRemaining)),
                              })}
                      </span>
                      {splitRemaining >= 0 && <MoneyDisplay amount={splitRemaining} size="sm" />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-3">
                  {availableMethods.map(m => (
                    <POSButton
                      key={m}
                      type="button"
                      touchSize="xl"
                      variant={method === m ? 'default' : 'outline'}
                      disabled={isProcessing}
                      data-testid={`payment-btn-${m.replace('_', '-')}`}
                      onClick={() => {
                        setMethod(m);
                      }}
                    >
                      {paymentLabels[m]}
                    </POSButton>
                  ))}
                </div>
              )}
            </section>

            {!isSplitMode && method === 'cash' && (
              <section className="space-y-3">
                <MoneyInput
                  label={t('paymentForm.amountTendered')}
                  value={tenderedAmount}
                  onChange={setTenderedAmount}
                  disabled={isProcessing}
                />
                <div
                  className="grid grid-cols-5 gap-2"
                  role="group"
                  aria-label={t('paymentForm.quickTenderGroup')}
                >
                  <POSButton
                    type="button"
                    variant="outline"
                    touchSize="large"
                    disabled={isProcessing}
                    data-testid="quick-tender-exact"
                    onClick={() => {
                      setTenderedAmount(runningTotal);
                    }}
                  >
                    {t('paymentForm.quickTenderExact')}
                  </POSButton>
                  {QUICK_TENDER_AMOUNTS.map(amount => (
                    <POSButton
                      key={amount}
                      type="button"
                      variant="outline"
                      touchSize="large"
                      disabled={isProcessing}
                      data-testid={`quick-tender-${String(amount)}`}
                      aria-label={t('paymentForm.quickTender', { amount: formatMoney(amount) })}
                      onClick={() => {
                        setTenderedAmount(amount);
                      }}
                    >
                      {formatMoney(amount)}
                    </POSButton>
                  ))}
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm font-medium">
                  <span>{t('paymentForm.changeDue')}</span>
                  <MoneyDisplay amount={changeDue} size="lg" />
                </div>
              </section>
            )}

            {!isSplitMode && isReferencedMethod && (
              <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                <p className="text-sm font-medium">{t('paymentForm.processOnBbvaTerminal')}</p>
                <MoneyInput
                  label={t('paymentForm.chargeAmount')}
                  value={effectiveCardAmount}
                  onChange={setCardChargeOverride}
                  disabled={isProcessing}
                />
                {cardChargeOverride !== null && (
                  <POSButton
                    type="button"
                    variant="ghost"
                    touchSize="default"
                    data-testid="card-override-reset"
                    className="text-xs text-muted-foreground underline"
                    onClick={() => {
                      setCardChargeOverride(null);
                    }}
                  >
                    {t('paymentForm.resetToComputed', { amount: formatMoney(runningTotal) })}
                  </POSButton>
                )}
                <div className="space-y-2">
                  <Label htmlFor="card-ref">{t('paymentForm.referenceOptional')}</Label>
                  <Input
                    id="card-ref"
                    value={cardReference}
                    onChange={e => {
                      setCardReference(e.target.value);
                    }}
                    placeholder={t('paymentForm.terminalReceiptPlaceholder')}
                    maxLength={64}
                    disabled={isProcessing}
                    autoComplete="off"
                  />
                </div>
              </section>
            )}

            {!isSplitMode && method === 'bank_transfer' && (
              <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                <div className="space-y-2">
                  <Label htmlFor="bank-transfer-customer-name">
                    {t('featOrders:checkoutSale.customerNameLabel')}
                  </Label>
                  <Input
                    id="bank-transfer-customer-name"
                    value={customerName}
                    onChange={e => {
                      setCustomerName(e.target.value);
                    }}
                    placeholder={t('featOrders:checkoutSale.defaultCustomerName')}
                    maxLength={100}
                    disabled={isProcessing}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bank-transfer-customer-phone">
                    {t('featOrders:checkoutSale.customerPhoneLabel')}
                  </Label>
                  <Input
                    id="bank-transfer-customer-phone"
                    value={customerPhone}
                    onChange={e => {
                      setCustomerPhone(e.target.value);
                    }}
                    placeholder={t('featOrders:checkoutSale.customerPhonePlaceholder')}
                    maxLength={30}
                    disabled={isProcessing}
                    autoComplete="off"
                    data-testid="bank-transfer-phone-input"
                  />
                </div>
              </section>
            )}

            {errorMessage && (
              <div
                className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive-soft p-3.5 text-sm text-destructive"
                role="alert"
                data-testid="payment-error-alert"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      <div className="flex flex-col gap-2 border-t border-border bg-background px-4 py-3 sm:flex-row-reverse sm:items-center sm:px-6 sm:py-4">
        <ProtectedAction
          action="close_tab"
          currentRole={currentRole}
          disabled={isProcessing || (isSplitMode ? !canSubmitSplit : !canSubmit)}
        >
          <POSButton
            type="button"
            touchSize="xl"
            focusEmphasis="high"
            disabled={isProcessing || (isSplitMode ? !canSubmitSplit : !canSubmit)}
            variant="brand"
            className="w-full sm:flex-1"
            onClick={() => {
              if (isSplitMode) {
                void handleSplitPrimary();
              } else {
                void handlePrimary();
              }
            }}
          >
            {isProcessing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                {t('paymentForm.processing')}
              </span>
            ) : (
              primaryLabel
            )}
          </POSButton>
        </ProtectedAction>
        {onClose && (
          <POSButton
            type="button"
            touchSize="large"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={isProcessing}
            onClick={onClose}
          >
            {t('paymentForm.cancel')}
          </POSButton>
        )}
      </div>
      <ConfirmDialog
        open={showOfflineDialog}
        title={t('paymentForm.offlineTitle')}
        description={t('paymentForm.offlineBody')}
        confirmLabel={tCommon('actions.tryAgain')}
        cancelLabel={tCommon('actions.cancel')}
        onConfirm={() => {
          setShowOfflineDialog(false);
          void (isSplitMode ? handleSplitPrimary() : handlePrimary());
        }}
        onCancel={() => {
          setShowOfflineDialog(false);
        }}
      />
      <ManagerPinDialog
        open={pinDialogOpen}
        onOpenChange={open => {
          setPinDialogOpen(open);
          if (!open) setPinPurpose(null);
        }}
        requiredAction="apply_custom_discount"
        onSuccess={staff => {
          setPinDialogOpen(false);
          setManagerOverride(true);
          setAuthorizingManagerPin(staff.pin);
          if (pinPurpose === 'discount') {
            setDiscountExpanded(true);
          } else if (pinPurpose === 'below_cost') {
            // Resubmit the SAME payment attempt (idempotencyKeyRef is
            // untouched on a failed attempt) with managerOverride: true —
            // a retry, not a new sale. staff.pin is passed explicitly
            // (not read from state) since this fires in the same tick as
            // setAuthorizingManagerPin above, before React commits it.
            void (isSplitMode
              ? handleSplitPrimary(true, staff.pin)
              : handlePrimary(true, staff.pin));
          }
          setPinPurpose(null);
        }}
      />
    </>
  );
}

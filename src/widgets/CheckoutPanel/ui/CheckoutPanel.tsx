import { listen } from '@tauri-apps/api/event';
import { ArrowRight, Eraser, PauseCircle, ScanBarcode, Search, ShoppingBag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PaymentForm } from '@widgets/PaymentModal/ui/PaymentForm';
import { ProductGrid } from '@widgets/ProductGrid/ui/ProductGrid';
import { useAddLooseWeightItem } from '@features/add-loose-weight-item/model/useAddLooseWeightItem';
import { WeightEntryDialog } from '@features/add-loose-weight-item/ui/WeightEntryDialog';
import { useCheckoutSale } from '@features/checkout-sale/model/useCheckoutSale';
import { HoldSaleBanner } from '@features/hold-sale/ui/HoldSaleBanner';
import {
  ADD_TO_CART_EVENT,
  BARCODE_SCANNED_EVENT,
  ensurePeekWindowShown,
} from '@features/open-product-peek-window/model/useProductPeekWindow';
import type { AddToCartPayload } from '@features/open-product-peek-window/model/useProductPeekWindow';
import { useSavedSale } from '@features/resume-sale/model/useSavedSale';
import {
  RestoredSaleReview,
  type RestoredReviewStatus,
} from '@features/resume-sale/ui/RestoredSaleReview';
import { ResumeSaleDialog } from '@features/resume-sale/ui/ResumeSaleDialog';
import { useNearExpiryPricingDates } from '@entities/inventory';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { useCategories } from '@entities/product';
import {
  evaluateCombos,
  resolveProductPromotion,
  usePromotions,
  type ComboCategoryLookup,
} from '@entities/promotion';
import { useSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff';
import { cartItemsToComboLines, useCartStore } from '@entities/tab/model/cartStore';
import { CartItem } from '@entities/tab/ui/CartItem';
import { useOnlineStatus } from '@shared/lib/connectivity';
import type { Product } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { useLockStateStore } from '@shared/lib/lock-state-store';
import { isTauri } from '@shared/lib/pos-printer';
import { useBarcodeScanner } from '@shared/lib/useBarcodeScanner';
import { Badge, ConfirmDialog, MoneyDisplay, POSButton, ScrollArea } from '@shared/ui';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { useRehydrateReconcile } from '../lib/useRehydrateReconcile';
import {
  OfflineChip,
  OfflineLimitMessage,
  ReRingChip,
  ReRingNotLinkedWarning,
} from './OfflineCheckoutChrome';
import { SubmissionRecoveryGate } from './SubmissionRecoveryGate';

// Combos have day-of-week/time-window recurrence like discount promotions
// (isPromotionLiveAt) — re-evaluate on this tick so a live-updating cart
// doesn't need a page refresh to pick up a combo that just came into (or
// went out of) its active window. Mirrors PaymentForm's own
// DEFAULT_TIMEZONE fallback (process_direct_sale_atomic's
// COALESCE(..., 'America/Mexico_City')) for when settings hasn't loaded yet.
const COMBO_REEVALUATION_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = 'America/Mexico_City';

export function CheckoutPanel() {
  const { t } = useTranslation('wPanels');
  const weightEntry = useAddLooseWeightItem();
  const checkout = useCartStore(state => state.checkout);
  const openCheckout = useCartStore(state => state.openCheckout);
  const clearCheckout = useCartStore(state => state.clearCheckout);
  const setCheckoutDraft = useCartStore(state => state.setCheckoutDraft);
  // Phase 30: the open checkout is store state, so a restart can offer to resume it.
  const paymentOpen = checkout?.open === true;
  // D-03: restored lines (persisted ids) still in the cart are compared with current values; Pay is
  // held until the review reports clear for exactly this set (anything else is fail-closed).
  const restoredIds = useCartStore(state => state.restoredSnapshotLineIds);
  const setRestoredIds = useCartStore(state => state.setRestoredSnapshotLineIds);
  const [reviewReport, setReviewReport] = useState<{ key: string; status: RestoredReviewStatus } | null>(null);
  const reportReview = useCallback((key: string, status: RestoredReviewStatus) => {
    setReviewReport({ key, status });
  }, []);
  const [editingWeightItemId, setEditingWeightItemId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  // The completion warning the cashier has already acknowledged (by identity: a new one shows again).
  const [acknowledgedError, setAcknowledgedError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  // Scanning is only safe on the ordinary cart screen: while payment/receipt
  // UI is mounted (paymentOpen) or a weight dialog owns the register
  // (weightEntry.isOpen for add, editingWeightItemId for edit), a scan must
  // not silently add to or reopen a cart that a modal transition is about to
  // clear or that is not currently editable (CHK-01, T-02-08-01). Also gated
  // on !locked (T-21-06, RESEARCH.md Pitfall 3): this hook's window-level
  // keydown listener is genuinely global -- it fires regardless of the
  // idle-lock overlay's own focus trap -- so without this gate a raw
  // barcode-scanner keystroke burst could still open/refresh the Product
  // Peek window while the screen visually appears locked, defeating the
  // lock's purpose even though no cart mutation occurs.
  const locked = useLockStateStore(s => s.locked);
  const scannerEnabled =
    !paymentOpen && !weightEntry.isOpen && editingWeightItemId === null && !locked;
  // A scan only populates the product search box — it never adds to the cart
  // by itself. useBarcodeScanner hands over the full scanned code in one
  // call, so this always replaces `search` rather than appending to it.
  useBarcodeScanner({
    enabled: scannerEnabled,
    onScan: code => {
      setSearch(code);
      void ensurePeekWindowShown(code);
    },
  });
  const { data: categories } = useCategories();
  const promotionsQuery = usePromotions();
  const { data: activePromotions } = promotionsQuery;
  // Pricing source for the near-expiry tier: expiry dates, not the staff-facing alert list.
  const nearExpiryQuery = useNearExpiryPricingDates();
  const { data: nearExpiryDates } = nearExpiryQuery;
  const { data: appSettings } = useSettings();
  // Resolves the live, promotion-discounted price match for a product at
  // scan/select time (PROMO-03, display only — process_direct_sale_atomic
  // remains the sole price authority at checkout). Returns undefined when
  // no promotion/expiry-trigger qualifies, so callers fall back to
  // cartStore's own product.basePrice default. Also carries promotionId
  // (PROMO-08) so addItem/addWeightedItem can stamp the cart line's
  // promotion snapshot for later reconnect conflict detection. A loose-weight
  // line passes its weight: the server discounts the LINE price, so the match
  // is then a line amount (see resolveProductPromotion).
  const resolvePromotionMatch = (product: Product, weightGrams?: number) => {
    if (!activePromotions || !appSettings) return undefined;
    return resolveProductPromotion(
      product,
      activePromotions,
      appSettings,
      nearExpiryDates,
      undefined,
      weightGrams
    );
  };
  // The ADD_TO_CART_EVENT listener below is registered once on mount
  // ([] deps, Tauri global event) — a plain closure over
  // resolvePromotionMatch would go stale the moment promotions/settings
  // finish loading after mount. Route through a ref updated every render
  // instead.
  const resolvePromotionMatchRef = useRef(resolvePromotionMatch);
  resolvePromotionMatchRef.current = resolvePromotionMatch;
  const savedSale = useSavedSale();
  const items = useCartStore(state => state.items);
  const total = useCartStore(state => state.totalAmount());
  const restoredLines = useMemo(() => items.filter(item => restoredIds.includes(item.tempId)), [items, restoredIds]);
  const reviewKey = restoredLines.map(item => item.tempId).join(',');
  const reviewStatus: RestoredReviewStatus = reviewReport?.key === reviewKey ? reviewReport.status : 'checking';
  const payBlockedReason =
    restoredLines.length === 0 || reviewStatus === 'clear'
      ? undefined
      : reviewStatus === 'blocked'
        ? t('resumeSale.conflict.blocked')
        : t('resumeSale.conflict.checking');
  const addItem = useCartStore(state => state.addItem);
  const addWeightedItem = useCartStore(state => state.addWeightedItem);
  const removeItem = useCartStore(state => state.removeItem);
  const setLineQuantity = useCartStore(state => state.setLineQuantity);
  const setItemNotes = useCartStore(state => state.setItemNotes);
  const clearCart = useCartStore(state => state.clearCart);
  const holdCart = useCartStore(state => state.holdCart);
  const isHeld = useCartStore(state => state.heldCart !== null);
  const reRing = useCartStore(state => state.reRing);
  // A payment was already attempted for this cart: it may have gone through whatever the screen says.
  const paymentAttempted = useCartStore(state => state.pendingIdempotencyKey !== null);
  // ...unless the record this cart re-rings is already closed as re-rung: then the payment DID go
  // through and is linked, and "clear the cart" is the right thing to do, with no double-charge warning.
  const reRingCompleted = useOfflineSaleStore(state => {
    const original = reRing ? state.records.find(r => r.id === reRing.saleId) : undefined;
    return original?.status === 'resolved' && original.resolution === 'rering';
  });
  const warnBeforeClear = reRing !== null && paymentAttempted && !reRingCompleted;
  const flagPriceConflict = useCartStore(state => state.flagPriceConflict);
  const setComboResult = useCartStore(state => state.setComboResult);
  const comboResult = useCartStore(state => state.comboResult);
  const comboNetSavings = useCartStore(state => state.comboNetSavings());
  const staffId = useStaffStore(state => state.currentStaff?.id ?? '');

  // A reload between "the offline sale was stored" and "Done" brings the cart back with the key it
  // was stored under. Paying it unchanged is safe (same key, same record), but EDITING it mints a
  // new key and a second sale holding lines that were already sold. So once, when the checkout
  // opens, a cart whose key belongs to a stored record is cleared. Only on open: while it is open
  // the receipt screen owns the cart and Done clears it.
  const [storedSaleNumber, setStoredSaleNumber] = useState<string | null>(null);
  useEffect(() => {
    const stores = [useCartStore.persist, useOfflineSaleStore.persist];
    const clearIfAlreadyStored = () => {
      const key = useCartStore.getState().pendingIdempotencyKey;
      if (key === null) return;
      const stored = useOfflineSaleStore.getState().records.find(r => r.request.idempotencyKey === key);
      if (!stored) return;
      useCartStore.getState().clearCart();
      setStoredSaleNumber(stored.receiptNumber);
    };
    if (stores.every(store => store.hasHydrated())) {
      clearIfAlreadyStored();
      return undefined;
    }
    // storage that hydrates asynchronously: look once both have
    const unsubscribers = stores.map(store =>
      store.onFinishHydration(() => {
        if (stores.every(s => s.hasHydrated())) clearIfAlreadyStored();
      })
    );
    return () => {
      unsubscribers.forEach(unsubscribe => {
        unsubscribe();
      });
    };
  }, []);
  // Shared by ProductGrid's tile-tap onSelect and the ADD_TO_CART_EVENT
  // peek-window listener below — both add a non-weighted product `times`
  // times (the peek-window listener uses its own `qty`; the tile tap always
  // passes 1).
  const addProductTimes = (product: Product, times: number) => {
    const match = resolvePromotionMatch(product);
    for (let i = 0; i < times; i += 1) {
      addItem(product, [], match?.discountedUnitPrice, match?.promotionId ?? null);
    }
  };
  const { syntheticTab, processors, reRingCompletionError } = useCheckoutSale(appSettings?.general, nearExpiryDates !== undefined);
  const editingWeightItem = items.find(item => item.tempId === editingWeightItemId);
  const hasPriceConflict = items.some(item => item.priceConflict);

  // Task 5: minimal-per-product lookup for evaluateCombos' category-chain
  // eligibility walk, memoized on the categories query's own data reference
  // (stable until refetch) rather than rebuilt every render.
  const categoriesById = useMemo(() => {
    const map = new Map<string, ComboCategoryLookup>();
    for (const category of categories ?? []) {
      map.set(category.id, { comboEligible: category.comboEligible, parentId: category.parentId });
    }
    return map;
  }, [categories]);

  // Combos carry the same day-of-week/time-window recurrence as discount
  // promotions (isPromotionLiveAt) — a cart left open across a window
  // boundary needs periodic re-evaluation, not just on cart/data changes.
  const [comboTick, setComboTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setComboTick(tick => tick + 1);
    }, COMBO_REEVALUATION_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const lines = cartItemsToComboLines(items);
    const timezone = appSettings?.general.timezone ?? DEFAULT_TIMEZONE;
    setComboResult(
      evaluateCombos(lines, activePromotions ?? [], new Date(), timezone, categoriesById)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- comboTick drives the periodic re-evaluation above; setComboResult is a stable Zustand action reference
  }, [items, activePromotions, categoriesById, appSettings, comboTick]);

  // Map<tempId, promotionName> — one lookup built once per render from the
  // latest combo evaluation, not per cart line, so CartItem's comboLabel prop
  // stays a cheap map read.
  const comboLabelByTempId = useMemo(() => {
    const map = new Map<string, string>();
    for (const application of comboResult?.applications ?? []) {
      for (const unit of application.units) {
        if (!map.has(unit.tempId)) {
          map.set(unit.tempId, application.promotionName);
        }
      }
    }
    return map;
  }, [comboResult]);

  // PROMO-08: on reconnect, re-evaluate every promotion-sourced cart line
  // against freshly-refetched promotions/near-expiry data. A stale offline
  // discount is never silently re-priced or silently trusted — a changed or
  // vanished result flags the line for the cashier to review (see
  // OfflineQueueProcessor's wasOnlineRef/transitionedOnline pattern, mirrored
  // here as a local effect since this only needs this component's own
  // already-available data, not the tab-offline-queue machinery).
  const isOnline = useOnlineStatus();
  const wasOnlineRef = useRef<boolean>(isOnline);
  useEffect(() => {
    const previouslyOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    const transitionedOnline = isOnline && !previouslyOnline;
    if (!transitionedOnline || !appSettings) return;

    void (async () => {
      const [promotionsResult, nearExpiryResult] = await Promise.all([
        promotionsQuery.refetch(),
        nearExpiryQuery.refetch(),
      ]);
      const freshPromotions = promotionsResult.data?.ok ? promotionsResult.data.data : [];
      const freshNearExpiry = nearExpiryResult.data?.ok ? nearExpiryResult.data.data : [];

      for (const item of useCartStore.getState().items) {
        if (!item.promotionId) continue;
        const weighted = item.weightGrams != null;
        const match = resolveProductPromotion(
          item.product,
          freshPromotions,
          appSettings,
          freshNearExpiry,
          undefined,
          item.weightGrams ?? undefined
        );
        // a weighted line's discounted price is its line total, not its per-kg unitPrice
        const changed =
          !match ||
          match.promotionId !== item.promotionId ||
          match.discountedUnitPrice !== (weighted ? item.lineTotal : item.unitPrice);
        if (changed) {
          flagPriceConflict(item.tempId);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on the online transition itself
  }, [isOnline]);

  useRehydrateReconcile({
    isOnline,
    promotions: promotionsQuery,
    nearExpiry: nearExpiryQuery,
    settings: appSettings,
  });

  // Relays a rescan captured by the peek window (which has OS focus while
  // open) back into this window's own search box, and applies the peek
  // window's "Add to Cart" commit to the real cart — the peek window has no
  // direct cartStore access of its own (D-04, separate JS/webview context).
  useEffect(() => {
    // No-op outside a real Tauri runtime — `listen()` throws when
    // `window.__TAURI_INTERNALS__` is absent (plain browser tab, e.g. this
    // project's Playwright suite driving `npm run dev`). The peek-window E2E
    // spec explicitly injects the same `window.__TAURI__` global this checks
    // for, so real cross-window coverage is unaffected.
    if (!isTauri()) return undefined;
    const unlistenScanned = listen<{ code: string }>(BARCODE_SCANNED_EVENT, event => {
      setSearch(event.payload.code);
    });
    const unlistenAddToCart = listen<AddToCartPayload>(ADD_TO_CART_EVENT, event => {
      const { product, qty, weightGrams } = event.payload;
      const match = resolvePromotionMatchRef.current(product, weightGrams ?? undefined);
      if (weightGrams != null) {
        addWeightedItem(
          product,
          weightGrams,
          match?.discountedUnitPrice,
          match?.promotionId ?? null
        );
      } else {
        const times = qty ?? 1;
        for (let i = 0; i < times; i += 1) {
          addItem(product, [], match?.discountedUnitPrice, match?.promotionId ?? null);
        }
      }
    });
    return () => {
      void unlistenScanned.then(unlisten => {
        unlisten();
      });
      void unlistenAddToCart.then(unlisten => {
        unlisten();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addItem/addWeightedItem are stable Zustand action references (never change identity)
  }, []);

  // Offline, the one refusal that stops checkout before the pay screen is the limit (Ruling 16);
  // every other reason is explained next to the control it affects on the pay screen.
  const offlineRefusal = isOnline
    ? null
    : processors.offlineRefusal({ method: 'cash', hasDiscount: false, hasOverride: false });
  const limitReason =
    offlineRefusal === 'limit' || offlineRefusal === 'limit_count' || offlineRefusal === 'limit_age'
      ? offlineRefusal
      : null;

  // Phase 30: no cart or payment controls until the current caja is known (stale-cart guard).
  if (savedSale.state === 'loading') return null;

  // CART-04 (D-07): a payment was sent and never answered. Only the recovery screen is rendered, so no cart
  // or payment control exists until the outcome is known. Gate order: caja, marker, checkout.open, selling.
  if (savedSale.state === 'recovery') {
    return (
      <SubmissionRecoveryGate
        marker={savedSale.marker}
        items={items}
        totalCents={Math.round(total * 100)}
        draft={checkout?.draft ?? null}
        tab={syntheticTab}
        staffId={staffId}
        processors={processors}
        onDone={() => {
          toast.success(t('checkoutPanel.saleComplete', { amount: formatMoney(total) }));
          clearCart();
        }}
        onResolved={savedSale.resolveRecovery}
      />
    );
  }

  // D-01: nothing else is shown until the cashier decides (the draft is not revealed behind it).
  if (savedSale.state === 'resume') {
    return (
      <ResumeSaleDialog
        open
        items={items}
        totalCents={Math.round(total * 100)}
        draft={savedSale.draft}
        onResume={savedSale.resolveResume}
        onDiscard={savedSale.resolveDiscard}
      />
    );
  }

  if (paymentOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30">
        <div className="mx-auto flex size-full min-h-0 max-w-5xl flex-col border-x border-border bg-background shadow-lg">
          {reRingCompletionError && acknowledgedError !== reRingCompletionError && (
            <ReRingNotLinkedWarning
              error={reRingCompletionError}
              onAcknowledge={() => {
                setAcknowledgedError(reRingCompletionError);
              }}
            />
          )}
          {restoredLines.length > 0 && (
            <RestoredSaleReview
              items={restoredLines}
              reviewKey={reviewKey}
              onStatus={reportReview}
              onLinesResolved={lineIds => {
                setRestoredIds(restoredIds.filter(id => !lineIds.includes(id)));
              }}
              onRemoveLine={lineId => {
                removeItem(lineId);
                setRestoredIds(restoredIds.filter(id => id !== lineId));
              }}
            />
          )}
          <PaymentForm
            payBlockedReason={payBlockedReason}
            tab={syntheticTab}
            staffId={staffId}
            processors={processors}
            reRing={reRing}
            comboNetSavings={comboNetSavings}
            onPaymentSuccess={() => undefined}
            initialDraft={checkout.draft ?? undefined}
            onDraftChange={setCheckoutDraft}
            onClose={() => {
              // Do NOT clear the persisted idempotency key here (opus
              // re-review, Finding I-2): Cancel only hides the payment
              // screen, it does not abandon the cart. A lost-response retry
              // with the same cart must resend the same key so
              // process_direct_sale_atomic replays the original sale
              // instead of charging it twice.
              clearCheckout();
            }}
            onDone={() => {
              toast.success(t('checkoutPanel.saleComplete', { amount: formatMoney(total) }));
              // clearCart() is the single place that nulls the persisted
              // idempotency key (opus re-review, Finding I-1) — it must run
              // only once the cashier has actually seen/accepted the
              // receipt, not right after the RPC returns ok.
              clearCart();
            }}
          />
        </div>
      </div>
    );
  }

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const showStoredNotice = storedSaleNumber !== null && items.length === 0;
  const showStatusStrip = !isOnline || reRing !== null || showStoredNotice;

  return (
    <div
      className={`grid h-full min-h-0 ${
        showStatusStrip ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'
      } bg-background`}
    >
      {/* Toolbar: search/scan + held sale */}
      <div className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 lg:px-5">
        <div className="group/search relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[1.125rem] -translate-y-1/2 text-muted-foreground transition-colors group-focus-within/search:text-brand"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            value={search}
            onChange={event => {
              setSearch(event.target.value);
            }}
            placeholder={t('checkoutPanel.searchPlaceholder')}
            aria-label={t('checkoutPanel.searchPlaceholder')}
            className="h-12 rounded-xl pr-36 pl-11 text-base shadow-xs"
            autoComplete="off"
          />
          <span
            className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:flex"
            aria-hidden="true"
          >
            <ScanBarcode className="size-3.5" />
            {t('checkoutPanel.scanReady')}
          </span>
        </div>
        <HoldSaleBanner />
      </div>

      {showStatusStrip && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 lg:px-5">
          {!isOnline && <OfflineChip />}
          {reRing && <ReRingChip marker={reRing} />}
          {showStoredNotice && (
            <p
              role="status"
              data-testid="stored-sale-notice"
              className="text-sm font-medium text-success-strong"
            >
              {t('checkoutPanel.alreadyStored', { number: storedSaleNumber })}
            </p>
          )}
        </div>
      )}

      <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,28rem)]">
        {/* Catalogue */}
        <section className="flex min-h-0 flex-col gap-3 p-4 lg:p-5">
          <ProductGrid
            weightEntry={weightEntry}
            search={search}
            onSearchChange={setSearch}
            resolvePromotionMatch={resolvePromotionMatch}
            onSelect={product => {
              addProductTimes(product, 1);
            }}
          />
        </section>

        {/* Cart */}
        <aside className="flex min-h-0 flex-col border-l border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="flex items-center gap-2.5">
              <ShoppingBag className="size-[1.125rem] text-muted-foreground" aria-hidden="true" />
              <h2 className="text-base font-semibold tracking-tight">
                {t('checkoutPanel.cartTitle')}
              </h2>
              {itemCount > 0 && (
                <Badge variant="muted" className="tabular-nums">
                  {t('checkoutPanel.itemCount', { count: itemCount })}
                </Badge>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={items.length === 0}
              onClick={() => {
                setClearOpen(true);
              }}
            >
              <Eraser className="size-4" aria-hidden="true" />
              {t('checkoutPanel.clearCart')}
            </Button>
          </div>

          {items.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <ScanBarcode className="size-6" aria-hidden="true" strokeWidth={1.75} />
              </div>
              <div className="space-y-1">
                <p className="font-medium">{t('checkoutPanel.emptyCart')}</p>
                <p className="text-sm text-muted-foreground text-pretty">
                  {t('checkoutPanel.emptyCartDescription')}
                </p>
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-2 p-3">
                {items.map(item => (
                  <CartItem
                    key={item.tempId}
                    item={item}
                    onQuantitySet={quantity => {
                      setLineQuantity(item.tempId, quantity);
                    }}
                    onRemove={() => {
                      removeItem(item.tempId);
                    }}
                    onNotesChange={notes => {
                      setItemNotes(item.tempId, notes);
                    }}
                    comboLabel={comboLabelByTempId.get(item.tempId)}
                    {...(item.weightGrams != null
                      ? {
                          onEditWeight: () => {
                            setEditingWeightItemId(item.tempId);
                          },
                        }
                      : {})}
                  />
                ))}
              </div>
            </ScrollArea>
          )}

          {comboResult != null && comboResult.applications.length > 0 && (
            <section
              data-testid="combo-applications"
              className="shrink-0 space-y-1 border-t border-border px-4 py-2 text-sm"
            >
              {comboResult.applications.map((application, index) => (
                <div
                  // Applications aren't individually id'd on the cart side (an
                  // application can repeat the same promotionId), so pair id
                  // with index for a stable-enough key within one render.
                  key={`${application.promotionId}-${String(index)}`}
                  className="flex justify-between text-success-strong"
                >
                  <span>{application.promotionName}</span>
                  <span>−{formatMoney(application.net)}</span>
                </div>
              ))}
            </section>
          )}

          <div className="shrink-0 space-y-3 border-t border-border bg-background/60 p-4 backdrop-blur-sm">
            {limitReason && <OfflineLimitMessage reason={limitReason} id="offline-limit-reason" />}
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <dt>{t('checkoutPanel.subtotal')}</dt>
                <dd>
                  <MoneyDisplay amount={total} size="sm" />
                </dd>
              </div>
              {comboNetSavings > 0 && (
                <div className="flex justify-between text-success-strong">
                  <dt>{t('checkoutPanel.comboSavings')}</dt>
                  <dd data-testid="combo-savings">−{formatMoney(comboNetSavings)}</dd>
                </div>
              )}
              <div className="flex items-end justify-between">
                <dt className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  {t('checkoutPanel.cartTotal')}
                </dt>
                <dd data-testid="cart-total">
                  <MoneyDisplay
                    amount={total - comboNetSavings}
                    size="xl"
                    className="text-[2.5rem] leading-none"
                  />
                </dd>
              </div>
            </dl>
            {reRing && (
              <p id="rering-hold-reason" className="text-xs font-medium text-warning-strong">
                {t('checkoutPanel.reRing.holdBlocked')}
              </p>
            )}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <POSButton
                type="button"
                variant="outline"
                touchSize="xl"
                disabled={items.length === 0 || isHeld || reRing !== null}
                aria-describedby={reRing ? 'rering-hold-reason' : undefined}
                onClick={holdCart}
              >
                <PauseCircle className="size-5" aria-hidden="true" />
                {t('checkoutPanel.hold')}
              </POSButton>
              <POSButton
                type="button"
                variant="brand"
                touchSize="xl"
                className="justify-between px-6"
                disabled={items.length === 0 || !staffId || hasPriceConflict || limitReason !== null}
                aria-describedby={limitReason ? 'offline-limit-reason' : undefined}
                onClick={() => {
                  openCheckout();
                }}
              >
                <span>{t('checkoutPanel.processPayment')}</span>
                <ArrowRight className="size-5" aria-hidden="true" />
              </POSButton>
            </div>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={clearOpen}
        title={
          warnBeforeClear
            ? t('checkoutPanel.reRing.clearTitle')
            : t('checkoutPanel.clearCartTitle')
        }
        description={
          warnBeforeClear
            ? t('checkoutPanel.reRing.clearWarning')
            : t('checkoutPanel.clearCartBody')
        }
        confirmLabel={
          warnBeforeClear
            ? t('checkoutPanel.reRing.clearConfirm')
            : t('checkoutPanel.clearCartConfirm')
        }
        variant="destructive"
        onCancel={() => {
          setClearOpen(false);
        }}
        onConfirm={() => {
          clearCart();
          setClearOpen(false);
        }}
      />
      {editingWeightItem?.weightGrams != null && (
        <WeightEntryDialog
          open
          onOpenChange={open => {
            if (!open) setEditingWeightItemId(null);
          }}
          product={editingWeightItem.product}
          mode="edit"
          tempId={editingWeightItem.tempId}
          initialWeightGrams={editingWeightItem.weightGrams}
          resolveMatch={weightGrams => resolvePromotionMatch(editingWeightItem.product, weightGrams)}
        />
      )}
    </div>
  );
}

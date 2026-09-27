import { listen } from '@tauri-apps/api/event';
import { ArrowRight, Eraser, PauseCircle, ScanBarcode, Search, ShoppingBag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useNearExpiryAlerts } from '@entities/inventory';
import { useCategories } from '@entities/product';
import {
  evaluateBestPromotion,
  evaluateCombos,
  usePromotions,
  type ComboCartLine,
  type ComboCategoryLookup,
} from '@entities/promotion';
import { useSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff';
import { useCartStore } from '@entities/tab/model/cartStore';
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
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [editingWeightItemId, setEditingWeightItemId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
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
  const nearExpiryQuery = useNearExpiryAlerts();
  const { data: nearExpiryAlerts } = nearExpiryQuery;
  const { data: appSettings } = useSettings();
  // Resolves the live, promotion-discounted price match for a product at
  // scan/select time (PROMO-03, display only — process_direct_sale_atomic
  // remains the sole price authority at checkout). Returns undefined when
  // no promotion/expiry-trigger qualifies, so callers fall back to
  // cartStore's own product.basePrice default. Also carries promotionId
  // (PROMO-08) so addItem/addWeightedItem can stamp the cart line's
  // promotion snapshot for later reconnect conflict detection.
  const resolvePromotionMatch = (product: Product) => {
    if (!activePromotions || !appSettings) return undefined;
    const daysUntilExpiry =
      nearExpiryAlerts?.find(alert => alert.productId === product.id)?.daysUntilExpiry ?? null;
    return evaluateBestPromotion(
      { productId: product.id, categoryId: product.categoryId, basePrice: product.basePrice },
      activePromotions,
      new Date(),
      appSettings.nearExpiry.discountPercent,
      daysUntilExpiry,
      appSettings.nearExpiry.thresholdDays,
      appSettings.general.timezone
    );
  };
  // The ADD_TO_CART_EVENT listener below is registered once on mount
  // ([] deps, Tauri global event) — a plain closure over
  // resolvePromotionMatch would go stale the moment promotions/settings
  // finish loading after mount. Route through a ref updated every render
  // instead.
  const resolvePromotionMatchRef = useRef(resolvePromotionMatch);
  resolvePromotionMatchRef.current = resolvePromotionMatch;
  const items = useCartStore(state => state.items);
  const total = useCartStore(state => state.totalAmount());
  const addItem = useCartStore(state => state.addItem);
  const addWeightedItem = useCartStore(state => state.addWeightedItem);
  const removeItem = useCartStore(state => state.removeItem);
  const setLineQuantity = useCartStore(state => state.setLineQuantity);
  const setItemNotes = useCartStore(state => state.setItemNotes);
  const clearCart = useCartStore(state => state.clearCart);
  const holdCart = useCartStore(state => state.holdCart);
  const isHeld = useCartStore(state => state.heldCart !== null);
  const flagPriceConflict = useCartStore(state => state.flagPriceConflict);
  const setComboResult = useCartStore(state => state.setComboResult);
  const comboResult = useCartStore(state => state.comboResult);
  const comboNetSavings = useCartStore(state => state.comboNetSavings());
  const staffId = useStaffStore(state => state.currentStaff?.id ?? '');
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
  const { syntheticTab, processors, resetIdempotencyKey } = useCheckoutSale();
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
    const lines: ComboCartLine[] = items.map(item => {
      const modifierDelta = item.selectedModifiers.reduce((sum, m) => sum + m.priceDelta, 0);
      return {
        tempId: item.tempId,
        productId: item.product.id,
        categoryId: item.product.categoryId,
        quantity: item.quantity,
        unitPrice: item.product.basePrice + modifierDelta,
        lineDiscountPerUnit: Math.max(0, item.product.basePrice - item.unitPrice),
        soldByWeight: item.weightGrams != null,
        comboEligible: item.product.comboEligible,
      };
    });
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
        const daysUntilExpiry =
          freshNearExpiry.find(alert => alert.productId === item.product.id)?.daysUntilExpiry ??
          null;
        const match = evaluateBestPromotion(
          {
            productId: item.product.id,
            categoryId: item.product.categoryId,
            basePrice: item.product.basePrice,
          },
          freshPromotions,
          new Date(),
          appSettings.nearExpiry.discountPercent,
          daysUntilExpiry,
          appSettings.nearExpiry.thresholdDays,
          appSettings.general.timezone
        );
        const changed =
          !match ||
          match.promotionId !== item.promotionId ||
          match.discountedUnitPrice !== item.unitPrice;
        if (changed) {
          flagPriceConflict(item.tempId);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on the online transition itself
  }, [isOnline]);

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
      const match = resolvePromotionMatchRef.current(product);
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

  if (paymentOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30">
        <div className="mx-auto flex size-full min-h-0 max-w-5xl flex-col border-x border-border bg-background shadow-lg">
          <PaymentForm
            tab={syntheticTab}
            staffId={staffId}
            processors={processors}
            comboNetSavings={comboNetSavings}
            onPaymentSuccess={() => undefined}
            onClose={() => {
              resetIdempotencyKey();
              setPaymentOpen(false);
            }}
            onDone={() => {
              toast.success(t('checkoutPanel.saleComplete', { amount: formatMoney(total) }));
              resetIdempotencyKey();
              clearCart();
              setPaymentOpen(false);
            }}
          />
        </div>
      </div>
    );
  }

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background">
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
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <POSButton
                type="button"
                variant="outline"
                touchSize="xl"
                disabled={items.length === 0 || isHeld}
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
                disabled={items.length === 0 || !staffId || hasPriceConflict}
                onClick={() => {
                  setPaymentOpen(true);
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
        title={t('checkoutPanel.clearCartTitle')}
        description={t('checkoutPanel.clearCartBody')}
        confirmLabel={t('checkoutPanel.clearCartConfirm')}
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
        />
      )}
    </div>
  );
}

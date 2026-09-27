import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PackageSearch, ScanBarcode } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WeightEntryDialog } from '@features/add-loose-weight-item/ui/WeightEntryDialog';
import { useLookupProductByBarcode } from '@features/lookup-product-by-barcode/model/useLookupProductByBarcode';
import {
  ADD_TO_CART_EVENT,
  BARCODE_SCANNED_EVENT,
  PEEK_WINDOW_REFRESH_EVENT,
} from '@features/open-product-peek-window/model/useProductPeekWindow';
import { useNearExpiryAlerts } from '@entities/inventory';
import { getProductRiskFlag } from '@entities/product/model/productRiskFlag';
import { useConfirmRiskyAdd } from '@entities/product/model/useConfirmRiskyAdd';
import { evaluateBestPromotion, usePromotions } from '@entities/promotion';
import { useSettings } from '@entities/settings';
import type { Product } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { isTauri } from '@shared/lib/pos-printer';
import { useBarcodeScanner } from '@shared/lib/useBarcodeScanner';
import { cn } from '@shared/lib/utils';
import {
  Badge,
  CardSkeleton,
  EmptyState,
  MoneyDisplay,
  POSButton,
  QuantityControl,
  StatusBadge,
} from '@shared/ui';
import type { InventoryStockBadgeStatus } from '@shared/ui/StatusBadge';

/**
 * `InventoryRow.tsx`'s `stockTier()` is not exported and operates on
 * `Inventory` (non-optional fields), not `Product` (optional
 * `quantityOnHand`/`lowStockThreshold`) — inline the same three comparisons
 * here rather than importing something that doesn't fit this caller's type
 * (RESEARCH.md "Don't Hand-Roll"). An undefined inventory join (no row) is
 * treated as in-stock, not downgraded.
 */
function productStockTier(product: Product): InventoryStockBadgeStatus {
  const { quantityOnHand, lowStockThreshold } = product;
  if (quantityOnHand === undefined || lowStockThreshold === undefined) return 'inv_in_stock';
  if (quantityOnHand === 0) return 'inv_out_of_stock';
  if (quantityOnHand <= lowStockThreshold) return 'inv_low_stock';
  return 'inv_in_stock';
}

function PeekWindowShell({
  header,
  children,
  footer,
}: {
  header?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col bg-background">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-card p-4">
        {footer}
      </div>
    </div>
  );
}

function washStyle(color: string | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  // eslint-disable-next-line i18next/no-literal-string -- CSS color-mix expression, not UI copy
  return { backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` };
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('wPanels');
  return (
    <POSButton type="button" variant="outline" touchSize="large" onClick={onClose}>
      {t('common:actions.close')}
    </POSButton>
  );
}

function LoadingStateView({ onClose }: { onClose: () => void }) {
  return (
    <PeekWindowShell footer={<CloseButton onClose={onClose} />}>
      <CardSkeleton height={208} className="rounded-none border-0" />
      <div className="space-y-5 px-6 py-5">
        <CardSkeleton height={40} />
        <CardSkeleton height={120} />
      </div>
    </PeekWindowShell>
  );
}

function NotFoundStateView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('wPanels');
  const scannedCode = new URLSearchParams(window.location.search).get('barcode');
  return (
    <PeekWindowShell footer={<CloseButton onClose={onClose} />}>
      <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
        <EmptyState
          icon={PackageSearch}
          title={t('featOrders:scanBarcodeToCart.productNotFound')}
          description={t('productPeekPanel.notFoundBody')}
        />
        {scannedCode && (
          <div className="flex flex-col items-center gap-1">
            <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {t('productPeekPanel.scannedCode')}
            </span>
            <span className="rounded-md bg-muted px-3 py-1 font-mono text-sm">{scannedCode}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('productPeekPanel.scanAgainHint')}</p>
      </div>
    </PeekWindowShell>
  );
}

function ErrorStateView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('wPanels');
  return (
    <PeekWindowShell footer={<CloseButton onClose={onClose} />}>
      <div className="px-6 py-10">
        <p className="text-sm text-destructive" role="alert">
          {t('productPeekPanel.loadError')}
        </p>
      </div>
    </PeekWindowShell>
  );
}

function PeekProductDetail({
  product,
  onClose,
  confirmRiskyAdd,
  weightDialogOpen,
  setWeightDialogOpen,
}: {
  product: Product;
  onClose: () => void;
  confirmRiskyAdd: ReturnType<typeof useConfirmRiskyAdd>;
  weightDialogOpen: boolean;
  setWeightDialogOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation('wPanels');
  const [qty, setQty] = useState(1);
  const stockTier = productStockTier(product);
  const { data: activePromotions } = usePromotions();
  const { data: appSettings } = useSettings();
  const { data: nearExpiryAlerts } = useNearExpiryAlerts();
  const match =
    activePromotions && appSettings
      ? evaluateBestPromotion(
          { productId: product.id, categoryId: product.categoryId, basePrice: product.basePrice },
          activePromotions,
          new Date(),
          appSettings.nearExpiry.discountPercent,
          nearExpiryAlerts?.find(alert => alert.productId === product.id)?.daysUntilExpiry ?? null,
          appSettings.nearExpiry.thresholdDays,
          appSettings.general.timezone
        )
      : null;
  const unitPrice = match?.discountedUnitPrice ?? product.basePrice;
  const lineTotal = product.soldByWeight ? unitPrice : unitPrice * qty;
  const meterMax = Math.max((product.lowStockThreshold ?? 0) * 3, 1);
  const meterPct = Math.min(
    100,
    Math.max(0, Math.round(((product.quantityOnHand ?? 0) / meterMax) * 100))
  );
  const initials = product.name.trim().slice(0, 2).toUpperCase();

  const commit = () => {
    if (product.soldByWeight) {
      setWeightDialogOpen(true);
      return;
    }
    void emit(ADD_TO_CART_EVENT, { product, qty });
    onClose();
  };

  const handleAddToCart = () => {
    const flag = getProductRiskFlag(product);
    if (flag) {
      confirmRiskyAdd(flag, product, commit);
      return;
    }
    commit();
  };

  return (
    <>
      <PeekWindowShell
        header={
          <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/50 px-5 py-2.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ScanBarcode className="size-4" aria-hidden="true" />
              <span className="font-semibold tracking-[0.12em] uppercase">
                {t('productPeekPanel.scannedEyebrow')}
              </span>
            </div>
            {product.category && (
              <Badge variant="muted" className="gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: product.category.color }}
                  aria-hidden="true"
                />
                {product.category.name}
              </Badge>
            )}
          </div>
        }
        footer={
          <>
            <div className="mr-auto flex flex-col leading-tight">
              {qty > 1 && (
                <>
                  <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {t('productPeekPanel.total')}
                  </span>
                  <MoneyDisplay amount={lineTotal} size="lg" />
                </>
              )}
            </div>
            <CloseButton onClose={onClose} />
            <POSButton
              type="button"
              variant="brand"
              touchSize="xl"
              className="min-w-44"
              onClick={handleAddToCart}
            >
              {t('productPeekPanel.addToCart')}
            </POSButton>
          </>
        }
      >
        <div
          className="relative flex h-52 items-center justify-center overflow-hidden bg-muted"
          style={washStyle(product.category?.color)}
        >
          {product.category && (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-1"
              style={{ backgroundColor: product.category.color }}
            />
          )}
          {product.imageUrl ? (
            <img src={product.imageUrl} alt={product.name} className="size-full object-contain p-4" />
          ) : (
            <>
              <span aria-hidden="true" className="text-6xl font-semibold tracking-tight text-foreground/70">
                {initials}
              </span>
              <span className="sr-only">{t('productPeekPanel.noPhoto')}</span>
            </>
          )}
        </div>

        <div className="space-y-5 px-6 py-5">
          <h1 title={product.name} className="line-clamp-2 text-2xl font-semibold tracking-tight">
            {product.name}
          </h1>

          <div className="flex flex-wrap items-end gap-3">
            <MoneyDisplay
              amount={unitPrice}
              size="xl"
              className={cn('text-4xl', match && 'text-success-strong')}
            />
            <Badge variant="muted">
              {product.soldByWeight ? t('productPeekPanel.perKg') : t('productPeekPanel.each')}
            </Badge>
            {match && (
              <div className="flex items-center gap-2">
                <Badge variant="success">{t('productPeekPanel.promoPrice')}</Badge>
                <span className="text-sm text-muted-foreground line-through">
                  {t('productPeekPanel.wasPrice', { price: formatMoney(product.basePrice) })}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <StatusBadge status={stockTier} />
              <span className="text-sm text-muted-foreground">
                {t('productPeekPanel.stockCount', { count: product.quantityOnHand ?? 0 })}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className={cn(
                  'h-full rounded-full',
                  stockTier === 'inv_out_of_stock'
                    ? 'bg-destructive'
                    : stockTier === 'inv_low_stock'
                      ? 'bg-warning'
                      : 'bg-success'
                )}
                style={{ width: `${String(meterPct)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {product.soldByWeight
                ? t('productPeekPanel.unitWeight')
                : t('productPeekPanel.unitPiece')}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <dt className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t('productPeekPanel.skuLabel')}
              </dt>
              <dd className="font-mono">
                <span>{product.sku ?? '—'}</span>
              </dd>
            </div>
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <dt className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                {t('productPeekPanel.barcodeLabel')}
              </dt>
              <dd className="font-mono">
                <span>{product.barcode ?? '—'}</span>
              </dd>
            </div>
          </dl>

          {!product.soldByWeight && <QuantityControl value={qty} onChange={setQty} />}
        </div>
      </PeekWindowShell>
      {product.soldByWeight && (
        <WeightEntryDialog
          open={weightDialogOpen}
          onOpenChange={setWeightDialogOpen}
          product={product}
          mode="add"
          onConfirm={weightGrams => {
            void emit(ADD_TO_CART_EVENT, { product, weightGrams });
            onClose();
          }}
        />
      )}
    </>
  );
}

export function ProductPeekWindow() {
  const { lookup } = useLookupProductByBarcode();
  const confirmRiskyAdd = useConfirmRiskyAdd();
  // undefined = loading, null = not-found-or-error-resolved-null, Product = populated
  const [product, setProduct] = useState<Product | null | undefined>(undefined);
  const [hasError, setHasError] = useState(false);

  const [weightDialogOpen, setWeightDialogOpen] = useState(false);

  const loadProduct = useCallback(
    async (code: string) => {
      setHasError(false);
      setProduct(undefined);
      // A rescan (direct or relayed) always targets the currently-displayed
      // product's dialog, if any was left open by a prior load — closing it
      // here is defensive: CR-02's gates below should already prevent a
      // rescan from reaching this function while the dialog is open.
      setWeightDialogOpen(false);
      try {
        // Trim first — scanner whitespace/newline artifacts must never cause
        // a false not-found on the exact-match lookup (specless-fallback
        // PEEK-01/encoding, backstop).
        const result = await lookup(code.trim());
        setProduct(result);
      } catch {
        // Defensive last resort: useLookupProductByBarcode already swallows
        // Supabase errors into a resolved `null`, so a real RLS/auth-session
        // failure will present as "not found" (NotFoundStateView), not this
        // branch — Plan 18-03's dedicated session-restore E2E test is what
        // actually catches that failure mode.
        setHasError(true);
      }
    },
    [lookup]
  );

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('barcode');
    if (code) {
      void loadProduct(code);
    } else {
      // Defensive: ensurePeekWindowShown always supplies a barcode via the
      // creation URL, so this branch should not occur in practice.
      setProduct(null);
    }
    // Only ever read the barcode once, from the window that opened us.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, loadProduct identity is stable across the single barcode read
  }, []);

  // Own scanner instance — the peek window has OS focus while open (D-01).
  // Rescanning here both re-fetches locally (PEEK-04) and relays the raw
  // code to the main window so its own search box stays in sync (D-02).
  // Disabled while the weight dialog owns entry (CR-02, mirrors
  // CheckoutPanel's scannerEnabled): a scan mid-entry would otherwise collide
  // with the dialog's own global keydown handler and swap out the displayed
  // product underneath it.
  useBarcodeScanner({
    enabled: !weightDialogOpen,
    onScan: code => {
      void loadProduct(code);
      void emit(BARCODE_SCANNED_EVENT, { code });
    },
  });

  // ensurePeekWindowShown's reuse path (existing window already open →
  // show/setFocus/emit instead of a fresh navigation) needs a way to tell
  // this already-open window to load the newly-scanned product — without
  // this listener it just refocuses on the stale, first-scanned product
  // (CR-01). Uses a distinct event from BARCODE_SCANNED_EVENT (this window's
  // own peek→main relay, below) so this listener can never catch its own
  // scan's relay if Tauri's global emit() self-delivers to the sender.
  // Same weightDialogOpen gate as the direct scanner above.
  useEffect(() => {
    if (!isTauri() || weightDialogOpen) return undefined;
    const unlistenRefresh = listen<{ code: string }>(PEEK_WINDOW_REFRESH_EVENT, event => {
      void loadProduct(event.payload.code);
    });
    return () => {
      void unlistenRefresh.then(unlisten => {
        unlisten();
      });
    };
  }, [loadProduct, weightDialogOpen]);

  const handleClose = () => {
    // Never .close()/.destroy() — the peek window is hidden and reused on
    // the next scan (D-03).
    void getCurrentWebviewWindow().hide();
  };

  if (hasError) return <ErrorStateView onClose={handleClose} />;
  if (product === undefined) return <LoadingStateView onClose={handleClose} />;
  if (product === null) return <NotFoundStateView onClose={handleClose} />;

  return (
    <PeekProductDetail
      key={product.id}
      product={product}
      onClose={handleClose}
      confirmRiskyAdd={confirmRiskyAdd}
      weightDialogOpen={weightDialogOpen}
      setWeightDialogOpen={setWeightDialogOpen}
    />
  );
}

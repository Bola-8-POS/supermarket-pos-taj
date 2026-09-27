import { AlertTriangle, Scale, X, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNearExpiryAlerts } from '@entities/inventory';
import { evaluateBestPromotion, usePromotions } from '@entities/promotion';
import { useSettings } from '@entities/settings';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CartItem as CartItemType } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { POSButton } from '@shared/ui/POSButton';
import { QuantityControl } from '@shared/ui/QuantityControl';
import { Badge } from '@shared/ui/badge';
import { Input } from '@shared/ui/input';

export interface CartItemProps {
  item: CartItemType;
  onQuantitySet: (quantity: number) => void;
  onRemove: () => void;
  onNotesChange: (notes: string) => void;
  onEditWeight?: () => void;
  /** Name of the combo promotion that consumed at least one unit of this line (Task 5), undefined when none. */
  comboLabel: string | undefined;
}

export function CartItem({
  item,
  onQuantitySet,
  onRemove,
  onNotesChange,
  onEditWeight,
  comboLabel,
}: CartItemProps) {
  const { t } = useTranslation('entities');
  const { data: nearExpiryAlerts } = useNearExpiryAlerts();
  const nearExpiry = nearExpiryAlerts?.find(alert => alert.productId === item.product.id);
  // Detects any discounted line regardless of source (promotion or
  // expiry-trigger) — ad-hoc/custom discounts never touch cart-line
  // unitPrice (D-10), only promotions do, so this stays accurate.
  const isDiscounted = item.unitPrice !== item.product.basePrice;

  // PROMO-08: resolves the flagged line to its fresh price/promotion at tap
  // time (never a stale cached value) and clears priceConflict.
  const { data: activePromotions } = usePromotions();
  const { data: appSettings } = useSettings();
  const resolveConflict = useCartStore(state => state.resolveConflict);
  const handleResolveConflict = () => {
    if (!activePromotions || !appSettings) return;
    const daysUntilExpiry =
      nearExpiryAlerts?.find(alert => alert.productId === item.product.id)?.daysUntilExpiry ?? null;
    const match = evaluateBestPromotion(
      {
        productId: item.product.id,
        categoryId: item.product.categoryId,
        basePrice: item.product.basePrice,
      },
      activePromotions,
      new Date(),
      appSettings.nearExpiry.discountPercent,
      daysUntilExpiry,
      appSettings.nearExpiry.thresholdDays,
      appSettings.general.timezone
    );
    resolveConflict(
      item.tempId,
      match?.discountedUnitPrice ?? item.product.basePrice,
      match?.promotionId ?? null
    );
  };
  const discountPercent =
    isDiscounted && item.product.basePrice > 0
      ? Math.round(((item.product.basePrice - item.unitPrice) / item.product.basePrice) * 100)
      : null;
  return (
    <div
      data-testid="cart-line"
      className="group/line flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 shadow-xs transition-colors hover:border-border-strong animate-fade-in"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h4 className="truncate text-sm font-semibold tracking-tight">{item.product.name}</h4>
          <p className="text-xs text-muted-foreground">
            {item.weightGrams != null ? (
              t('cartItem.weight', { weight: (item.weightGrams / 1000).toFixed(3) })
            ) : (
              <>
                {formatMoney(item.unitPrice)} × {item.quantity}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <MoneyDisplay amount={item.lineTotal} size="md" className="font-semibold" />
          {(isDiscounted || (discountPercent !== null && discountPercent > 0)) && (
            <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-success-strong">
              <Zap className="size-3" aria-label={t('cartItem.promotionApplied')} />
              {discountPercent !== null && discountPercent > 0
                ? t('cartItem.discountBadge', { percent: discountPercent })
                : null}
            </span>
          )}
        </div>
      </div>

      {(nearExpiry ||
        item.priceConflict ||
        item.selectedModifiers.length > 0 ||
        comboLabel !== undefined) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {comboLabel !== undefined ? (
            <Badge variant="brand" data-testid="cart-item-combo-badge">
              {t('cartItem.comboApplied', { name: comboLabel })}
            </Badge>
          ) : null}
          {nearExpiry ? (
            <Badge variant="warning">
              {t('cartItem.nearExpiry', { days: nearExpiry.daysUntilExpiry })}
            </Badge>
          ) : null}
          {item.priceConflict ? (
            <POSButton
              type="button"
              variant="destructive"
              touchSize="default"
              size="sm"
              className="gap-1.5"
              onClick={handleResolveConflict}
            >
              <AlertTriangle className="size-3.5" />
              {t('cartItem.priceConflict')}
            </POSButton>
          ) : null}
          {item.selectedModifiers.map(mod => (
            <Badge key={mod.id} variant="secondary">
              {mod.name}
              {mod.priceDelta > 0 ? ` ${formatMoney(mod.priceDelta, { showSign: true })}` : ''}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {item.weightGrams != null ? (
          <POSButton
            type="button"
            variant="outline"
            size="sm"
            touchSize="default"
            onClick={onEditWeight}
          >
            <Scale className="size-4" aria-hidden="true" />
            {t('cartItem.editWeight')}
          </POSButton>
        ) : (
          <QuantityControl value={item.quantity} min={1} max={99} onChange={onQuantitySet} />
        )}
        <POSButton
          type="button"
          variant="ghost"
          touchSize="default"
          size="icon"
          className="text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
          onClick={onRemove}
          aria-label={t('cartItem.remove', { name: item.product.name })}
        >
          <X className="size-4" />
        </POSButton>
      </div>

      <Input
        data-testid={`cart-item-notes-${item.product.id}`}
        type="text"
        placeholder={t('cartItem.notesPlaceholder')}
        value={item.notes}
        maxLength={200}
        className="h-8 rounded-md border-transparent bg-muted/60 px-2.5 text-xs shadow-none hover:border-border focus-visible:bg-card"
        onChange={e => {
          onNotesChange(e.target.value);
        }}
        aria-label={t('cartItem.notesFor', { name: item.product.name })}
      />
    </div>
  );
}

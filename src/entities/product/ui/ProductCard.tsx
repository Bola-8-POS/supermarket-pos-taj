import { Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Product, Category } from '@shared/lib/domain';
import { cn } from '@shared/lib/utils';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';

export interface ProductCardProps {
  product: Product;
  category: Category;
  /** Catalog clock (defaults to `new Date()`), retained for prop-compat with callers. */
  now?: Date;
  onSelect: (product: Product) => void;
  className?: string;
}

export function ProductCard({ product, category, onSelect, className }: ProductCardProps) {
  const { t } = useTranslation('entities');
  const displayPrice = product.basePrice;
  const unavailable = !product.isActive;

  const handleClick = () => {
    if (unavailable) return;
    if ('vibrate' in navigator) navigator.vibrate(10);
    onSelect(product);
  };

  return (
    <POSButton
      type="button"
      touchSize="large"
      variant="outline"
      disabled={unavailable}
      onClick={handleClick}
      className={cn(
        'group/card relative h-auto min-h-[6.75rem] w-full flex-col items-stretch justify-between gap-3 overflow-hidden rounded-xl border-border bg-card p-3 text-left font-normal shadow-xs',
        'transition-[transform,box-shadow,border-color] duration-150 ease-out-quart',
        'hover:-translate-y-px hover:border-brand/50 hover:bg-card hover:shadow-md',
        'active:translate-y-0 active:scale-[0.985] active:shadow-xs',
        unavailable && 'cursor-not-allowed opacity-60 hover:translate-y-0 hover:shadow-xs',
        className
      )}
      aria-label={t('productCard.selectRegularPrice', { name: product.name })}
      aria-disabled={unavailable}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1 opacity-80"
        style={{ backgroundColor: category.color }}
      />
      <div className="flex w-full items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: category.color }}
            aria-hidden="true"
          />
          <span className="truncate text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            {category.name}
          </span>
        </div>
        {product.soldByWeight && (
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-strong"
            aria-hidden="true"
          >
            <Scale className="size-3.5" />
          </span>
        )}
      </div>

      <h3 className="line-clamp-2 w-full text-sm leading-snug font-semibold tracking-tight text-foreground">
        {product.name}
      </h3>

      <div className="flex w-full items-end justify-between gap-2">
        <MoneyDisplay amount={displayPrice} size="md" className="leading-none" />
        {unavailable ? (
          <Badge variant="muted">{t('productCard.outOfStock')}</Badge>
        ) : product.barcode ? (
          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground/80">
            {t('productCard.barcodeLabel', { code: product.barcode })}
          </span>
        ) : null}
      </div>
    </POSButton>
  );
}

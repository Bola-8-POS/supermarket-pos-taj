import { PackageSearch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { useAddLooseWeightItem } from '@features/add-loose-weight-item/model/useAddLooseWeightItem';
import { WeightEntryDialog } from '@features/add-loose-weight-item/ui/WeightEntryDialog';
import { useBrands } from '@entities/brand';
import { useCategories, useProducts } from '@entities/product';
import { getProductRiskFlag } from '@entities/product/model/productRiskFlag';
import { useConfirmRiskyAdd } from '@entities/product/model/useConfirmRiskyAdd';
import { CategoryTabs } from '@entities/product/ui/CategoryTabs';
import { ProductCard } from '@entities/product/ui/ProductCard';
import type { PromotionMatch } from '@entities/promotion';
import type { Category, Product } from '@shared/lib/domain';
import { ProductGridSkeleton } from '@shared/ui';

export function ProductGrid({
  onSelect,
  weightEntry,
  search,
  onSearchChange,
  resolvePromotionMatch,
}: {
  onSelect: (product: Product) => void;
  weightEntry: ReturnType<typeof useAddLooseWeightItem>;
  search: string;
  onSearchChange: (value: string) => void;
  /**
   * Resolves the live promotion/expiry-triggered price for a product
   * (PROMO-03/PROMO-09) — used for the grid's own loose-weight
   * WeightEntryDialog (mode="add"), the one direct-select path CheckoutPanel's
   * own onSelect prop never sees for weighted products.
   */
  resolvePromotionMatch: (product: Product) => PromotionMatch | null | undefined;
}) {
  const { t } = useTranslation('wPanels');
  const confirmRiskyAdd = useConfirmRiskyAdd();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // D-12: secondary brand/weight-unit filters narrow WITHIN the active
  // category tab (AND logic) — CategoryTabs itself stays untouched.
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [activeWeightUnit, setActiveWeightUnit] = useState<string | null>(null);
  const {
    data: products = [],
    isIdleOrLoading: productsLoading,
    resultError: productsError,
  } = useProducts();
  const {
    data: categories = [],
    isIdleOrLoading: categoriesLoading,
    resultError: categoriesError,
  } = useCategories();
  const { data: brands = [] } = useBrands();
  const query = search.trim().toLowerCase();
  const matches = products.filter(
    product =>
      (activeCategory === null || product.categoryId === activeCategory) &&
      (activeBrand === null || product.brandId === activeBrand) &&
      (activeWeightUnit === null || product.weightUnit === activeWeightUnit) &&
      (!query ||
        product.name.toLowerCase().includes(query) ||
        product.sku?.toLowerCase().includes(query) ||
        product.barcode?.toLowerCase().includes(query))
  );

  if (productsLoading || categoriesLoading) return <ProductGridSkeleton />;
  const resultError = productsError ?? categoriesError;
  if (resultError)
    return (
      <p className="text-sm text-destructive" role="alert">
        {resultError.message}
      </p>
    );
  const selectProduct = (product: Product) => {
    const commit = () => {
      if (product.soldByWeight) weightEntry.openFor(product);
      else onSelect(product);
      onSearchChange('');
    };
    const flag = getProductRiskFlag(product);
    if (flag) {
      confirmRiskyAdd(flag, product, commit);
      return;
    }
    commit();
  };

  const fallbackCategory: Category = {
    // eslint-disable-next-line i18next/no-literal-string -- category namespace, not UI copy
    id: '00000000-0000-4000-8000-000000000000',
    name: t('categoryTabs.all', { ns: 'entities' }),
    // eslint-disable-next-line i18next/no-literal-string -- CSS design token, not UI copy
    color: 'var(--muted-foreground)',
    sortOrder: 0,
    happyHourStart: null,
    happyHourEnd: null,
    routing: 'NONE',
    comboEligible: true,
    createdAt: new Date(0),
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <CategoryTabs
        categories={categories}
        activeCategory={activeCategory}
        onChange={category => {
          setActiveCategory(category);
        }}
        className="shrink-0"
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          className="h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-xs dark:bg-input/20"
          aria-label={t('checkoutPanel.brandFilterLabel')}
          value={activeBrand ?? ''}
          onChange={e => {
            setActiveBrand(e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">{t('checkoutPanel.allBrands')}</option>
          {brands.map(b => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          className="h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-xs dark:bg-input/20"
          aria-label={t('checkoutPanel.weightUnitFilterLabel')}
          value={activeWeightUnit ?? ''}
          onChange={e => {
            setActiveWeightUnit(e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">{t('checkoutPanel.allWeightUnits')}</option>
          {
            // eslint-disable-next-line i18next/no-literal-string -- unit codes (matches the weight_unit enum values), not UI copy
            (['g', 'kg', 'lb', 'oz'] as const).map(u => (
              <option key={u} value={u}>
                {u}
              </option>
            ))
          }
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pb-2">
        {matches.length === 0 ? (
          <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-strong p-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <PackageSearch className="size-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t('checkoutPanel.noProductsFound')}</p>
              <p className="text-sm text-muted-foreground">
                {t('checkoutPanel.noProductsFoundDescription')}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {matches.map(product => (
              <ProductCard
                key={product.id}
                product={product}
                category={product.category ?? fallbackCategory}
                onSelect={selectProduct}
              />
            ))}
          </div>
        )}
      </div>
      {weightEntry.product && (
        <WeightEntryDialog
          open={weightEntry.isOpen}
          onOpenChange={open => {
            if (!open) weightEntry.close();
          }}
          product={weightEntry.product}
          mode="add"
          {...(() => {
            const match = resolvePromotionMatch(weightEntry.product);
            return match
              ? { pricePerKgOverride: match.discountedUnitPrice, promotionId: match.promotionId }
              : {};
          })()}
        />
      )}
    </section>
  );
}

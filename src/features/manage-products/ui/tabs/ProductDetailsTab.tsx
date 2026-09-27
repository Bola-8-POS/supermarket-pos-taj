import { useTranslation } from 'react-i18next';
import type { Brand, Category } from '@shared/lib/domain';
import { FormField } from '@shared/ui/FormField';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { Checkbox } from '@shared/ui/checkbox';
import { Input } from '@shared/ui/input';

export type ProductDetailsTabProps = {
  name: string;
  onNameChange: (value: string) => void;
  categories: Category[];
  categoryId: string;
  onCategoryIdChange: (value: string) => void;
  /** Phase 32 D-08: brand-select + weight fields sit right after Category. */
  brands: Brand[];
  brandId: string;
  onBrandIdChange: (value: string) => void;
  /** String buffer (Pattern 2) — never the parsed number; see ProductDetailDialog's submit-time parse. */
  weightAmountInput: string;
  onWeightAmountInputChange: (value: string) => void;
  weightUnit: string;
  onWeightUnitChange: (value: string) => void;
  basePrice: number;
  onBasePriceChange: (value: number) => void;
  sku: string;
  onSkuChange: (value: string) => void;
  barcode: string;
  onBarcodeChange: (value: string) => void;
  isActive: boolean;
  onIsActiveChange: (value: boolean) => void;
  comboEligible: boolean;
  onComboEligibleChange: (value: boolean) => void;
  fieldErrors: Record<string, string>;
  submitting: boolean;
};

/**
 * Details panel of `ProductDetailDialog` (Phase 31 D-02). Field logic, Zod
 * parsing, and error flattening all live in the parent dialog — this
 * component is presentational only, lifted verbatim from `ProductForm.tsx`.
 */
export function ProductDetailsTab({
  name,
  onNameChange,
  categories,
  categoryId,
  onCategoryIdChange,
  brands,
  brandId,
  onBrandIdChange,
  weightAmountInput,
  onWeightAmountInputChange,
  weightUnit,
  onWeightUnitChange,
  basePrice,
  onBasePriceChange,
  sku,
  onSkuChange,
  barcode,
  onBarcodeChange,
  isActive,
  onIsActiveChange,
  comboEligible,
  onComboEligibleChange,
  fieldErrors,
  submitting,
}: ProductDetailsTabProps) {
  const { t } = useTranslation('featMgmt');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FormField
        label={t('manageProducts.productForm.nameLabel')}
        required
        error={fieldErrors.name ?? ''}
        className="lg:col-span-2"
      >
        <Input
          value={name}
          onChange={e => {
            onNameChange(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={t('manageProducts.productForm.categoryLabel')}
        required
        error={fieldErrors.categoryId ?? ''}
      >
        <select
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs dark:bg-input/20"
          value={categoryId}
          onChange={e => {
            onCategoryIdChange(e.target.value);
          }}
          disabled={submitting || categories.length === 0}
        >
          {categories.length === 0 ? (
            <option value="">{t('manageProducts.productForm.noCategories')}</option>
          ) : null}
          {categories.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        label={t('manageProducts.productForm.brandLabel')}
        error={fieldErrors.brandId ?? ''}
      >
        <select
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs dark:bg-input/20"
          value={brandId}
          onChange={e => {
            onBrandIdChange(e.target.value);
          }}
          disabled={submitting}
        >
          <option value="">{t('manageProducts.productForm.noBrand')}</option>
          {brands.map(b => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        label={t('manageProducts.productForm.weightAmountLabel')}
        error={fieldErrors.weightAmount ?? ''}
      >
        <Input
          inputMode="decimal"
          value={weightAmountInput}
          onChange={e => {
            onWeightAmountInputChange(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={t('manageProducts.productForm.weightUnitLabel')}
        error={fieldErrors.weightUnit ?? ''}
      >
        <select
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs dark:bg-input/20"
          value={weightUnit}
          onChange={e => {
            onWeightUnitChange(e.target.value);
          }}
          disabled={submitting}
        >
          <option value="g">{t('manageProducts.productForm.weightUnitGram')}</option>
          <option value="kg">{t('manageProducts.productForm.weightUnitKilogram')}</option>
          <option value="lb">{t('manageProducts.productForm.weightUnitPound')}</option>
          <option value="oz">{t('manageProducts.productForm.weightUnitOunce')}</option>
        </select>
      </FormField>

      <FormField
        label={t('manageProducts.productForm.basePriceLabel')}
        required
        error={fieldErrors.basePrice ?? ''}
      >
        <MoneyInput value={basePrice} onChange={onBasePriceChange} disabled={submitting} />
      </FormField>

      {/* Happy-hour pricing is now managed in Settings → Promotions (D-01). */}

      <FormField label={t('manageProducts.productForm.skuLabel')} error={fieldErrors.sku ?? ''}>
        <Input
          value={sku}
          onChange={e => {
            onSkuChange(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={t('manageProducts.productForm.barcodeLabel')}
        hint={t('manageProducts.productForm.barcodeHint')}
        error={fieldErrors.barcode ?? ''}
      >
        <Input
          data-testid="product-form-barcode"
          value={barcode}
          onChange={e => {
            onBarcodeChange(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>

      <div className="flex items-center gap-2 lg:col-span-2">
        <Checkbox
          id="product-active"
          checked={isActive}
          onCheckedChange={v => {
            onIsActiveChange(v === true);
          }}
          disabled={submitting}
        />
        <label htmlFor="product-active" className="text-sm font-medium">
          {t('manageProducts.productForm.activeLabel')}
        </label>
      </div>

      <div className="flex items-center gap-2 lg:col-span-2">
        <Checkbox
          id="product-combo-eligible"
          checked={comboEligible}
          onCheckedChange={v => {
            onComboEligibleChange(v === true);
          }}
          disabled={submitting}
        />
        <label htmlFor="product-combo-eligible" className="text-sm font-medium">
          {t('manageProducts.productForm.comboEligibleLabel')}
        </label>
        <span className="text-xs text-muted-foreground">
          {t('manageProducts.productForm.comboEligibleHelp')}
        </span>
      </div>
    </div>
  );
}

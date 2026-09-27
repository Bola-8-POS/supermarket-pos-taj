import { useTranslation } from 'react-i18next';
import type { Modifier, Product, Supplier } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { FormField } from '@shared/ui/FormField';
import { ScrollArea } from '@shared/ui/ScrollArea';
import { Checkbox } from '@shared/ui/checkbox';
import { Input } from '@shared/ui/input';

export type ProductLinksTabProps = {
  unitsPerPackageInput: string;
  onUnitsPerPackageInputChange: (value: string) => void;
  parentProductIdInput: string;
  onParentProductIdInputChange: (value: string) => void;
  parentPackageOptions: Product[];
  imageUrl: string;
  onImageUrlChange: (value: string) => void;
  sortedModifiers: Modifier[];
  modifierIds: string[];
  onToggleModifier: (id: string) => void;
  suppliers: Supplier[];
  selectedSupplierIds: string[];
  onToggleSupplier: (id: string) => void;
  fieldErrors: Record<string, string>;
  submitting: boolean;
};

/**
 * Links panel of `ProductDetailDialog` (Phase 31 D-02) — units-per-package,
 * linked package product, the legacy image-URL field (D-13), and the
 * modifiers/suppliers checkbox wells. Lifted verbatim from `ProductForm.tsx`.
 */
export function ProductLinksTab({
  unitsPerPackageInput,
  onUnitsPerPackageInputChange,
  parentProductIdInput,
  onParentProductIdInputChange,
  parentPackageOptions,
  imageUrl,
  onImageUrlChange,
  sortedModifiers,
  modifierIds,
  onToggleModifier,
  suppliers,
  selectedSupplierIds,
  onToggleSupplier,
  fieldErrors,
  submitting,
}: ProductLinksTabProps) {
  const { t } = useTranslation('featMgmt');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FormField
        label={t('manageProducts.productForm.unitsPerPackageLabel')}
        hint={t('manageProducts.productForm.unitsPerPackageHint')}
        error={fieldErrors.unitsPerPackage ?? ''}
      >
        <Input
          type="number"
          min={1}
          step={1}
          value={unitsPerPackageInput}
          onChange={e => {
            onUnitsPerPackageInputChange(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={t('manageProducts.productForm.parentProductLabel')}
        hint={t('manageProducts.productForm.parentProductHint')}
        error={fieldErrors.parentProductId ?? ''}
      >
        <select
          className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs dark:bg-input/20"
          value={parentProductIdInput}
          onChange={e => {
            onParentProductIdInputChange(e.target.value);
          }}
          disabled={submitting}
        >
          <option value="">{t('manageProducts.productForm.noParentProduct')}</option>
          {parentPackageOptions.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField
        label={t('manageProducts.productForm.modifiersLabel')}
        error={fieldErrors.modifiers ?? ''}
      >
        <ScrollArea className="max-h-48 rounded-lg border border-border bg-card p-2">
          <ul className="space-y-2 pr-2">
            {sortedModifiers.length === 0 ? (
              <li className="text-muted-foreground text-sm">
                {t('manageProducts.productForm.noModifiersDefined')}
              </li>
            ) : (
              sortedModifiers.map(m => (
                <li key={m.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`mod-${m.id}`}
                    checked={modifierIds.includes(m.id)}
                    onCheckedChange={() => {
                      onToggleModifier(m.id);
                    }}
                    disabled={submitting}
                  />
                  <label htmlFor={`mod-${m.id}`} className="text-sm">
                    {m.name}{' '}
                    {/* eslint-disable i18next/no-literal-string -- signed money formatting (parens), not UI copy */}
                    <span className="text-muted-foreground">
                      ({formatMoney(m.priceDelta, { showSign: true })})
                    </span>
                    {/* eslint-enable i18next/no-literal-string */}
                  </label>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </FormField>

      <FormField label={t('manageProducts.productForm.suppliersLabel')}>
        <ScrollArea className="max-h-48 rounded-lg border border-border bg-card p-2">
          <ul className="space-y-2 pr-2">
            {suppliers.length === 0 ? (
              <li className="text-muted-foreground text-sm">
                {t('manageProducts.productForm.noSuppliersDefined')}
              </li>
            ) : (
              suppliers.map(supplier => (
                <li key={supplier.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`product-supplier-${supplier.id}`}
                    checked={selectedSupplierIds.includes(supplier.id)}
                    onCheckedChange={() => {
                      onToggleSupplier(supplier.id);
                    }}
                    disabled={submitting}
                  />
                  <label htmlFor={`product-supplier-${supplier.id}`} className="text-sm">
                    {supplier.name}
                  </label>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </FormField>

      <FormField
        label={t('manageProducts.productForm.imageUrlLabel')}
        error={fieldErrors.imageUrl ?? ''}
        className="lg:col-span-2"
      >
        <Input
          value={imageUrl}
          onChange={e => {
            onImageUrlChange(e.target.value);
          }}
          placeholder={t('manageProducts.productForm.imageUrlPlaceholder')}
          disabled={submitting}
        />
      </FormField>
    </div>
  );
}

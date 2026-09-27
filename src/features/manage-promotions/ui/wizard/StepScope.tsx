import { useTranslation } from 'react-i18next';
import { useCategories } from '@entities/category';
import { useProducts } from '@entities/product';
import { MultiSelectPicker } from '@shared/ui/MultiSelectPicker';
import { Checkbox } from '@shared/ui/checkbox';

export interface StepScopeProps {
  storeWide: boolean;
  onStoreWideChange: (checked: boolean) => void;
  selectedProductIds: string[];
  selectedCategoryIds: string[];
  onScopeSelectionChange: (next: { productIds: string[]; categoryIds: string[] }) => void;
  /** True once the admin tried to advance past this step while it was invalid. */
  showValidationError: boolean;
  disabled?: boolean;
}

/**
 * Scope step of the promotion wizard (D-01/D-07/D-08 partial). A
 * "Store-wide (no restriction)" checkbox that, when checked, disables and
 * clears the multi-select target picker below it.
 */
export function StepScope({
  storeWide,
  onStoreWideChange,
  selectedProductIds,
  selectedCategoryIds,
  onScopeSelectionChange,
  showValidationError,
  disabled = false,
}: StepScopeProps) {
  const { t } = useTranslation('wAdmin');
  const { data: products } = useProducts();
  const { data: categories } = useCategories();

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={storeWide}
          disabled={disabled}
          onCheckedChange={checked => {
            onStoreWideChange(checked === true);
          }}
        />
        <span className="text-sm font-medium">{t('promotionWizard.scope.storeWideLabel')}</span>
      </label>

      {!storeWide && (
        <MultiSelectPicker
          products={(products ?? []).map(p => ({ id: p.id, name: p.name }))}
          categories={(categories ?? []).map(c => ({
            id: c.id,
            name: c.name,
            parentId: c.parentId,
          }))}
          selectedProductIds={selectedProductIds}
          selectedCategoryIds={selectedCategoryIds}
          onChange={onScopeSelectionChange}
          disabled={disabled}
          placeholderText={t('promotionWizard.scope.pickerPlaceholder')}
          searchPlaceholder={t('promotionWizard.scope.searchPlaceholder')}
          productsGroupLabel={t('promotionWizard.scope.productsGroup')}
          categoriesGroupLabel={t('promotionWizard.scope.categoriesGroup')}
          emptyHeading={t('promotionWizard.scope.emptyHeading')}
          emptyBody={t('promotionWizard.scope.emptyBody')}
          removeLabel={name => t('promotionWizard.scope.removeChip', { name })}
        />
      )}

      {showValidationError && (
        <p className="text-sm text-destructive" role="alert">
          {t('promotionWizard.scope.validationError')}
        </p>
      )}
    </div>
  );
}

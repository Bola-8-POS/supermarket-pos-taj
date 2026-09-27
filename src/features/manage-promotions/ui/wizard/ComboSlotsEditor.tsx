import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormField, Input, POSButton } from '@shared/ui';
import {
  MultiSelectPicker,
  type MultiSelectCategoryItem,
  type MultiSelectProductItem,
} from '@shared/ui/MultiSelectPicker';
import type { SlotDraft } from '../../model/usePromotionWizardState';

export interface ComboSlotsEditorProps {
  slots: SlotDraft[];
  eligibleProducts: MultiSelectProductItem[];
  eligibleCategories: MultiSelectCategoryItem[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  onUpdate: (key: string, patch: Partial<Omit<SlotDraft, 'key'>>) => void;
  /** True once the admin tried to submit while the composition was invalid. */
  showValidationError: boolean;
  disabled?: boolean;
}

/**
 * Composition step of the combo builder (Task 7): an ordered list of slots —
 * each slot is "N units of [any of these eligible products/categories]".
 * Reuses StepScope's own MultiSelectPicker pattern per-slot, fed only
 * combo-eligible products/categories (the caller pre-filters via
 * `isProductComboEligible`/`isCategoryChainEligible`).
 */
export function ComboSlotsEditor({
  slots,
  eligibleProducts,
  eligibleCategories,
  onAdd,
  onRemove,
  onUpdate,
  showValidationError,
  disabled = false,
}: ComboSlotsEditorProps) {
  const { t } = useTranslation('wAdmin');
  const noEligibleCatalog = eligibleProducts.length === 0 && eligibleCategories.length === 0;

  return (
    <div className="space-y-4">
      {noEligibleCatalog && (
        <p className="text-sm text-muted-foreground">{t('promotionDialog.composition.noEligible')}</p>
      )}

      <div className="space-y-3">
        {slots.map((slot, index) => (
          <div key={slot.key} className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">
                {t('promotionDialog.composition.slot', { number: index + 1 })}
              </p>
              <POSButton
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={t('promotionDialog.composition.removeSlot')}
                onClick={() => {
                  onRemove(slot.key);
                }}
              >
                <Trash2 className="size-4" />
              </POSButton>
            </div>

            <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <FormField label={t('promotionDialog.composition.quantity')} required>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  inputMode="numeric"
                  value={slot.quantity}
                  disabled={disabled}
                  data-testid={`combo-slot-qty-${String(index)}`}
                  onChange={e => {
                    onUpdate(slot.key, { quantity: Number(e.target.value) });
                  }}
                />
              </FormField>
              <FormField label={t('promotionDialog.composition.label')}>
                <Input
                  value={slot.label}
                  disabled={disabled}
                  maxLength={60}
                  onChange={e => {
                    onUpdate(slot.key, { label: e.target.value });
                  }}
                />
              </FormField>
            </div>

            <MultiSelectPicker
              products={eligibleProducts}
              categories={eligibleCategories}
              selectedProductIds={slot.productIds}
              selectedCategoryIds={slot.categoryIds}
              disabled={disabled}
              onChange={next => {
                onUpdate(slot.key, { productIds: next.productIds, categoryIds: next.categoryIds });
              }}
              placeholderText={t('promotionWizard.scope.pickerPlaceholder')}
              searchPlaceholder={t('promotionWizard.scope.searchPlaceholder')}
              productsGroupLabel={t('promotionWizard.scope.productsGroup')}
              categoriesGroupLabel={t('promotionWizard.scope.categoriesGroup')}
              emptyHeading={t('promotionWizard.scope.emptyHeading')}
              emptyBody={t('promotionWizard.scope.emptyBody')}
              removeLabel={name => t('promotionWizard.scope.removeChip', { name })}
            />
          </div>
        ))}
      </div>

      <POSButton
        type="button"
        variant="outline"
        touchSize="default"
        disabled={disabled}
        data-testid="combo-add-slot"
        onClick={onAdd}
      >
        {t('promotionDialog.composition.addSlot')}
      </POSButton>

      {showValidationError && (
        <p className="text-sm text-destructive" role="alert">
          {t('promotionDialog.composition.validationError')}
        </p>
      )}
    </div>
  );
}

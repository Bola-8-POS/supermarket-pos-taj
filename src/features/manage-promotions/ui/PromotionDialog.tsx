import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCategories } from '@entities/category';
import { useProducts } from '@entities/product';
import {
  isCategoryChainEligible,
  isProductComboEligible,
  type ComboCategoryLookup,
  type Promotion,
} from '@entities/promotion';
import type { DiscountType, PromotionKind } from '@shared/lib/domain';
import { cn } from '@shared/lib/utils';
import { FormField, Input, MoneyInput, POSButton } from '@shared/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { usePromotionWizardState } from '../model/usePromotionWizardState';
import { ComboPricingSection } from './wizard/ComboPricingSection';
import { ComboSlotsEditor } from './wizard/ComboSlotsEditor';
import { StepReview } from './wizard/StepReview';
import { StepScope } from './wizard/StepScope';
import { StepValidityRecurrence } from './wizard/StepValidityRecurrence';

export interface PromotionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit/null for create mode; pass the row being edited for edit mode. */
  promotion?: Promotion | null;
}

/**
 * Create/edit promotion dialog. Replaces the 4-step wizard page: every field
 * is visible at once, validation runs on submit, and the right rail shows a
 * live summary + example price. State and save() come from
 * usePromotionWizardState unchanged — only the step navigation is gone.
 */
export function PromotionDialog({ open, onOpenChange, promotion = null }: PromotionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl" showCloseButton>
        {open && (
          <PromotionDialogForm
            key={promotion?.id ?? 'new'}
            promotion={promotion}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({
  index,
  title,
  hint,
  id,
}: {
  index: string;
  title: string;
  hint: string;
  id: string;
}) {
  return (
    <div className="space-y-1">
      <h3 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight">
        <span className="font-mono text-xs font-medium text-brand-strong">{index}</span>
        {title}
      </h3>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

function PromotionDialogForm({
  promotion,
  onClose,
}: {
  promotion: Promotion | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('wAdmin');
  const wizard = usePromotionWizardState(promotion);
  const isEdit = promotion !== null;
  const isCombo = wizard.kind === 'combo';
  const [attempted, setAttempted] = useState(false);
  const basicsRef = useRef<HTMLElement>(null);
  const scopeRef = useRef<HTMLElement>(null);
  const pricingRef = useRef<HTMLElement>(null);
  const whenRef = useRef<HTMLElement>(null);

  // Task 7: only combo-eligible products/categories (and every ancestor up
  // to 3 levels) can fill a combo slot — computed once here so both
  // ComboSlotsEditor and StepReview's worked example see the same catalog.
  const { data: allProducts } = useProducts();
  const { data: allCategories } = useCategories();
  const categoriesById = useMemo(() => {
    const map = new Map<string, ComboCategoryLookup>();
    for (const c of allCategories ?? []) {
      map.set(c.id, { comboEligible: c.comboEligible, parentId: c.parentId ?? null });
    }
    return map;
  }, [allCategories]);
  const eligibleProducts = useMemo(
    () => (allProducts ?? []).filter(p => isProductComboEligible(p, categoriesById)),
    [allProducts, categoriesById]
  );
  const eligibleCategories = useMemo(
    () => (allCategories ?? []).filter(c => isCategoryChainEligible(c.id, categoriesById)),
    [allCategories, categoriesById]
  );

  async function handleSubmit() {
    setAttempted(true);
    const basicsOk = wizard.validateBasics();
    const scopeOk = isCombo ? wizard.isCompositionValid() : wizard.isScopeStepValid();
    const pricingOk = !isCombo || wizard.isComboPricingValid();
    const whenOk = wizard.isValidityStepValid();
    const firstInvalid = !basicsOk
      ? basicsRef
      : !scopeOk
        ? scopeRef
        : !pricingOk
          ? pricingRef
          : !whenOk
            ? whenRef
            : null;
    if (firstInvalid) {
      firstInvalid.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const result = await wizard.save();
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(t('promotionFormDialog.savedToast'));
    onClose();
  }

  return (
    <>
      <DialogHeader className="border-b border-border px-6 py-5">
        <DialogTitle className="text-xl">
          {isEdit ? t('promotionFormDialog.editTitle') : t('promotionFormDialog.createTitle')}
        </DialogTitle>
        <DialogDescription>
          {isEdit ? t('promotionDialog.subtitleEdit') : t('promotionDialog.subtitleCreate')}
        </DialogDescription>
      </DialogHeader>

      <div className="grid max-h-[min(70dvh,44rem)] lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-0 space-y-8 overflow-y-auto px-6 py-5">
          <section ref={basicsRef} aria-labelledby="promo-basics" className="space-y-4 scroll-mt-4">
            {/* eslint-disable-next-line i18next/no-literal-string -- ordinal marker, not copy */}
            <SectionHeading
              id="promo-basics"
              index="01"
              title={t('promotionDialog.sectionBasics')}
              hint={t('promotionDialog.sectionBasicsHint')}
            />
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('promotionDialog.kind.label')}</p>
              <div
                className="flex gap-1 rounded-xl bg-muted p-1"
                {...(isEdit ? { title: t('promotionDialog.kind.editLockedHint') } : {})}
              >
                {/* eslint-disable-next-line i18next/no-literal-string -- fixed promotion-kind enum identifiers, not UI copy */}
                {(['discount', 'combo'] as const).map((k: PromotionKind) => (
                  <POSButton
                    key={k}
                    type="button"
                    touchSize="default"
                    variant={wizard.kind === k ? 'default' : 'ghost'}
                    aria-pressed={wizard.kind === k}
                    disabled={wizard.isPending || isEdit}
                    data-testid={`promotion-kind-${k}`}
                    onClick={() => {
                      wizard.setKind(k);
                    }}
                    className={cn('min-w-28', wizard.kind !== k && 'hover:bg-card')}
                  >
                    {k === 'discount'
                      ? t('promotionDialog.kind.discount')
                      : t('promotionDialog.kind.combo')}
                  </POSButton>
                ))}
              </div>
            </div>
            <FormField
              label={t('promotionFormDialog.nameLabel')}
              required
              {...(wizard.nameError ? { error: t(`promotionFormDialog.${wizard.nameError}`) } : {})}
            >
              <Input
                value={wizard.name}
                onChange={e => {
                  wizard.setName(e.target.value);
                }}
                disabled={wizard.isPending}
              />
            </FormField>
            {!isCombo && (
              <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('promotionFormDialog.discountTypeLabel')}</p>
                  <div className="flex gap-1 rounded-xl bg-muted p-1">
                    {/* eslint-disable-next-line i18next/no-literal-string -- fixed discount-type enum identifiers, not UI copy */}
                    {(['percent', 'fixed'] as const).map((type: DiscountType) => (
                      <POSButton
                        key={type}
                        type="button"
                        touchSize="default"
                        variant={wizard.discountType === type ? 'default' : 'ghost'}
                        aria-pressed={wizard.discountType === type}
                        disabled={wizard.isPending}
                        onClick={() => {
                          wizard.handleDiscountTypeChange(type);
                        }}
                        className={cn('min-w-28', wizard.discountType !== type && 'hover:bg-card')}
                      >
                        {type === 'percent'
                          ? t('promotionFormDialog.discountTypePercent')
                          : t('promotionFormDialog.discountTypeFixed')}
                      </POSButton>
                    ))}
                  </div>
                </div>
                {wizard.discountType === 'percent' ? (
                  <FormField
                    label={t('promotionFormDialog.discountPercentLabel')}
                    required
                    {...(wizard.valueError
                      ? { error: t(`promotionFormDialog.${wizard.valueError}`) }
                      : {})}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      inputMode="decimal"
                      value={wizard.discountPercentStr}
                      onChange={e => {
                        wizard.setDiscountPercentStr(e.target.value);
                      }}
                      disabled={wizard.isPending}
                    />
                  </FormField>
                ) : (
                  <FormField
                    label={t('promotionFormDialog.discountAmountLabel')}
                    required
                    {...(wizard.valueError
                      ? { error: t(`promotionFormDialog.${wizard.valueError}`) }
                      : {})}
                  >
                    <MoneyInput
                      value={wizard.discountValue}
                      onChange={wizard.setDiscountValue}
                      disabled={wizard.isPending}
                    />
                  </FormField>
                )}
              </div>
            )}
          </section>

          <section ref={scopeRef} aria-labelledby="promo-scope" className="space-y-4 scroll-mt-4">
            {/* eslint-disable-next-line i18next/no-literal-string -- ordinal marker, not copy */}
            <SectionHeading
              id="promo-scope"
              index="02"
              title={isCombo ? t('promotionDialog.composition.title') : t('promotionDialog.sectionScope')}
              hint={isCombo ? t('promotionDialog.composition.hint') : t('promotionDialog.sectionScopeHint')}
            />
            {isCombo ? (
              <ComboSlotsEditor
                slots={wizard.slots}
                eligibleProducts={eligibleProducts}
                eligibleCategories={eligibleCategories.map(c => ({
                  id: c.id,
                  name: c.name,
                  parentId: c.parentId ?? null,
                }))}
                onAdd={wizard.addSlot}
                onRemove={wizard.removeSlot}
                onUpdate={wizard.updateSlot}
                showValidationError={attempted && !wizard.isCompositionValid()}
                disabled={wizard.isPending}
              />
            ) : (
              <StepScope
                storeWide={wizard.storeWide}
                onStoreWideChange={wizard.handleStoreWideChange}
                selectedProductIds={wizard.selectedProductIds}
                selectedCategoryIds={wizard.selectedCategoryIds}
                onScopeSelectionChange={wizard.handleScopeSelectionChange}
                showValidationError={attempted && !wizard.isScopeStepValid()}
                disabled={wizard.isPending}
              />
            )}
          </section>

          {isCombo && (
            <section
              ref={pricingRef}
              aria-labelledby="promo-pricing"
              className="space-y-4 scroll-mt-4"
            >
              {/* eslint-disable-next-line i18next/no-literal-string -- ordinal marker, not copy */}
              <SectionHeading
                id="promo-pricing"
                index="03"
                title={t('promotionDialog.pricing.title')}
                hint={t('promotionDialog.pricing.hint')}
              />
              <ComboPricingSection
                comboPricing={wizard.comboPricing}
                onChange={wizard.setComboPricing}
                showValidationError={attempted && !wizard.isComboPricingValid()}
                totalSlotQuantity={wizard.totalSlotQuantity()}
                disabled={wizard.isPending}
              />
            </section>
          )}

          <section ref={whenRef} aria-labelledby="promo-when" className="space-y-4 scroll-mt-4">
            {/* eslint-disable-next-line i18next/no-literal-string -- ordinal marker, not copy */}
            <SectionHeading
              id="promo-when"
              index={isCombo ? '04' : '03'}
              title={t('promotionDialog.sectionWhen')}
              hint={t('promotionDialog.sectionWhenHint')}
            />
            <StepValidityRecurrence
              fromStr={wizard.fromStr}
              toStr={wizard.toStr}
              onDateRangeChange={wizard.handleDateRangeChange}
              recurring={wizard.recurring}
              onRecurringChange={wizard.handleRecurringChange}
              daysOfWeek={wizard.daysOfWeek}
              onToggleDayOfWeek={wizard.toggleDayOfWeek}
              startTime={wizard.startTime}
              endTime={wizard.endTime}
              onStartTimeChange={wizard.setStartTime}
              onEndTimeChange={wizard.setEndTime}
              showValidationError={attempted && !wizard.isValidityStepValid()}
              disabled={wizard.isPending}
            />
          </section>
        </div>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-muted/30 lg:block p-5">
          <p className="mb-3 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {t('promotionDialog.summaryTitle')}
          </p>
          <StepReview
            name={wizard.name}
            kind={wizard.kind}
            discountType={wizard.discountType}
            discountValue={wizard.discountValue}
            discountPercentStr={wizard.discountPercentStr}
            slots={wizard.slots}
            comboPricing={wizard.comboPricing}
            fromStr={wizard.fromStr}
            toStr={wizard.toStr}
            storeWide={wizard.storeWide}
            selectedProductIds={wizard.selectedProductIds}
            selectedCategoryIds={wizard.selectedCategoryIds}
            recurring={wizard.recurring}
            daysOfWeek={wizard.daysOfWeek}
            startTime={wizard.startTime}
            endTime={wizard.endTime}
          />
        </aside>
      </div>

      <DialogFooter className="mx-0 mb-0 rounded-b-2xl px-6 py-4 sm:justify-between">
        <POSButton type="button" variant="ghost" touchSize="large" disabled={wizard.isPending} onClick={onClose}>
          {t('promotionDialog.cancel')}
        </POSButton>
        <POSButton
          type="button"
          variant="brand"
          touchSize="large"
          disabled={wizard.isPending}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {isEdit ? t('promotionWizard.saveChanges') : t('promotionWizard.createPromotion')}
        </POSButton>
      </DialogFooter>
    </>
  );
}

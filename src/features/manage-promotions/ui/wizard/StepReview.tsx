import { useTranslation } from 'react-i18next';
import { useCategories } from '@entities/category';
import { useProducts } from '@entities/product';
import {
  evaluateBestPromotion,
  evaluateCombos,
  getCategoryChain,
  isProductComboEligible,
  type ComboCartLine,
  type ComboCategoryLookup,
  type Promotion,
} from '@entities/promotion';
import { useSettings } from '@entities/settings';
import type { DiscountType, Product, PromotionComboSlot, PromotionKind } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import type { ComboPricingDraft, SlotDraft } from '../../model/usePromotionWizardState';

export interface StepReviewProps {
  name: string;
  kind: PromotionKind;
  discountType: DiscountType;
  discountValue: number;
  discountPercentStr: string;
  /** Combo composition (Task 7) — always [] when kind === 'discount'. */
  slots: SlotDraft[];
  /** Combo pricing draft (Task 7) — ignored when kind === 'discount'. */
  comboPricing: ComboPricingDraft;
  fromStr: string;
  toStr: string;
  storeWide: boolean;
  selectedProductIds: string[];
  selectedCategoryIds: string[];
  recurring: boolean;
  daysOfWeek: number[] | null;
  startTime: string | null;
  endTime: string | null;
}

// Postgres EXTRACT(DOW) convention: 0=Sunday..6=Saturday (matches
// StepValidityRecurrence.tsx's own DAY_KEYS ordering).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

// Preview-only placeholder ids — never persisted, never rendered as visible
// UI copy (only ever fed into evaluateBestPromotion's Promotion-shaped
// argument), so these are identifiers, not translatable text.
// eslint-disable-next-line i18next/no-literal-string -- internal placeholder identifier, not UI copy
const PREVIEW_ID = 'preview';
// eslint-disable-next-line i18next/no-literal-string -- internal placeholder identifier, not UI copy
const PREVIEW_TARGET_ID = 'preview-target';

// Mirrors usePromotionWizardState.ts's own startOfDay/endOfDay — a plain,
// browser-local date-boundary helper. Fine for this preview's own
// non-authoritative computation (the wizard's real save() path uses the
// identical helper); process_direct_sale_atomic remains the sole checkout
// price authority regardless (Phase 27 precedent).
function startOfDay(str: string): Date {
  return new Date(`${str}T00:00:00`);
}

function endOfDay(str: string): Date {
  return new Date(`${str}T23:59:59`);
}

/**
 * The worked example's per-slot example product (Task 7 ambiguity
 * resolution): the first eligible product referenced by the slot's OWN
 * targets — if the slot targets specific products, the first of those; if
 * it targets a category, the first eligible product whose own ancestor
 * chain includes that category (same chain-walk `evaluateCombos`'s
 * `matchesSlot` uses at checkout — a slot targeting a PARENT category must
 * still resolve an example from a product filed under a child category).
 * Only searches `eligibleProducts` (never the full catalog) so the example
 * never suggests a product that couldn't actually fill this slot. Null when
 * the slot has no targets yet (e.g. a freshly-added, still-empty slot) — the
 * caller skips the whole worked example in that case.
 */
function resolveExampleProduct(
  slot: SlotDraft,
  eligibleProducts: Product[],
  categoriesById: Map<string, ComboCategoryLookup>
): Product | null {
  if (slot.productIds.length > 0) {
    const id = slot.productIds[0];
    return eligibleProducts.find(p => p.id === id) ?? null;
  }
  if (slot.categoryIds.length > 0) {
    const categoryId = slot.categoryIds[0];
    if (categoryId === undefined) return null;
    return (
      eligibleProducts.find(p => getCategoryChain(p.categoryId, categoriesById).includes(categoryId)) ??
      null
    );
  }
  return null;
}

function hasResolvedProduct(entry: {
  slot: SlotDraft;
  product: Product | null;
}): entry is { slot: SlotDraft; product: Product } {
  return entry.product !== null;
}

/**
 * Review step of the promotion wizard (D-07 final step, D-09 live preview).
 * Read-only summary of every prior-step value, plus a live computed-price
 * example via evaluateBestPromotion against the first catalog product
 * matching the wizard's in-progress (unsaved) scope. Rendered in
 * PromotionDialog's summary rail; the Create/Save action lives in the
 * dialog's footer.
 */
export function StepReview({
  name,
  kind,
  discountType,
  discountValue,
  discountPercentStr,
  slots,
  comboPricing,
  fromStr,
  toStr,
  storeWide,
  selectedProductIds,
  selectedCategoryIds,
  recurring,
  daysOfWeek,
  startTime,
  endTime,
}: StepReviewProps) {
  const { t } = useTranslation('wAdmin');
  const { data: products } = useProducts();
  const { data: categories } = useCategories();
  const { data: appSettings } = useSettings();
  const isCombo = kind === 'combo';

  const displayDiscountValue =
    discountType === 'percent' ? Number(discountPercentStr) : discountValue;

  const sampleProduct = storeWide
    ? (products ?? [])[0]
    : ((products ?? []).find(p => selectedProductIds.includes(p.id)) ??
      (products ?? []).find(p => selectedCategoryIds.includes(p.categoryId)));

  let preview: ReturnType<typeof evaluateBestPromotion> = null;
  if (!isCombo && sampleProduct && appSettings) {
    const previewPromotion: Promotion = {
      id: PREVIEW_ID,
      name: name.trim() || PREVIEW_ID,
      targets: storeWide
        ? []
        : [
            ...selectedProductIds.map(id => ({
              id: PREVIEW_TARGET_ID,
              promotionId: PREVIEW_ID,
              productId: id,
              categoryId: null,
            })),
            ...selectedCategoryIds.map(id => ({
              id: PREVIEW_TARGET_ID,
              promotionId: PREVIEW_ID,
              productId: null,
              categoryId: id,
            })),
          ],
      kind: 'discount',
      discountType,
      discountValue: displayDiscountValue,
      startsAt: startOfDay(fromStr),
      endsAt: endOfDay(toStr),
      daysOfWeek: recurring && daysOfWeek !== null && daysOfWeek.length > 0 ? daysOfWeek : null,
      startTime: recurring ? startTime : null,
      endTime: recurring ? endTime : null,
      needsReview: false,
      active: true,
      createdAt: new Date(),
      createdBy: null,
      slots: [],
    };
    preview = evaluateBestPromotion(
      {
        productId: sampleProduct.id,
        categoryId: sampleProduct.categoryId,
        basePrice: sampleProduct.basePrice,
      },
      [previewPromotion],
      new Date(),
      appSettings.nearExpiry.discountPercent,
      null,
      appSettings.nearExpiry.thresholdDays,
      appSettings.general.timezone
    );
  }

  // Task 7 combo worked example: resolve one example product per slot from
  // the slot's OWN targets, searching only combo-eligible products/matching
  // the same ancestor-chain rule evaluateCombos uses at checkout. Any slot
  // with no resolvable example product (e.g. still empty) silently skips
  // the whole worked example — no crash, just no "Example: …" line.
  const categoriesById = new Map<string, ComboCategoryLookup>(
    (categories ?? []).map(c => [c.id, { comboEligible: c.comboEligible, parentId: c.parentId ?? null }])
  );
  const eligibleProducts = (products ?? []).filter(p => isProductComboEligible(p, categoriesById));

  let comboPreview: { originalTotal: number; discountedTotal: number } | null = null;
  if (isCombo && slots.length > 0) {
    const resolved = slots.map(slot => ({
      slot,
      product: resolveExampleProduct(slot, eligibleProducts, categoriesById),
    }));
    const numericPricingValue = Number(comboPricing.value);
    if (resolved.every(hasResolvedProduct) && Number.isFinite(numericPricingValue)) {
      const comboSlots: PromotionComboSlot[] = resolved.map(({ slot }, index) => ({
        id: `${PREVIEW_ID}-slot-${String(index)}`,
        promotionId: PREVIEW_ID,
        position: index,
        quantity: slot.quantity,
        label: slot.label ? slot.label : null,
        targets: [
          ...slot.productIds.map(id => ({
            id: PREVIEW_TARGET_ID,
            promotionId: PREVIEW_ID,
            productId: id,
            categoryId: null,
          })),
          ...slot.categoryIds.map(id => ({
            id: PREVIEW_TARGET_ID,
            promotionId: PREVIEW_ID,
            productId: null,
            categoryId: id,
          })),
        ],
      }));
      const previewCombo: Promotion = {
        id: PREVIEW_ID,
        name: name.trim() || PREVIEW_ID,
        targets: [],
        kind: 'combo',
        discountType: comboPricing.type,
        discountValue: numericPricingValue,
        startsAt: startOfDay(fromStr),
        endsAt: endOfDay(toStr),
        daysOfWeek: recurring && daysOfWeek !== null && daysOfWeek.length > 0 ? daysOfWeek : null,
        startTime: recurring ? startTime : null,
        endTime: recurring ? endTime : null,
        needsReview: false,
        active: true,
        createdAt: new Date(),
        createdBy: null,
        slots: comboSlots,
      };
      const lines: ComboCartLine[] = resolved.filter(hasResolvedProduct).map(({ slot, product }, index) => ({
        tempId: `slot-${String(index)}`,
        productId: product.id,
        categoryId: product.categoryId,
        quantity: slot.quantity,
        unitPrice: product.basePrice,
        lineDiscountPerUnit: 0,
        soldByWeight: false,
        comboEligible: product.comboEligible,
      }));
      const evaluation = evaluateCombos(
        lines,
        [previewCombo],
        new Date(),
        // eslint-disable-next-line i18next/no-literal-string -- IANA timezone fallback identifier, not UI copy
        appSettings?.general.timezone ?? 'UTC',
        categoriesById
      );
      // A combo that isn't currently live (future-dated, or its
      // day/time-window recurrence doesn't match right now) produces zero
      // applications — evaluation.netSavings is then 0, which would
      // otherwise render a misleading "$X → $X" (no discount) line instead
      // of the discount-branch's own "no preview available" treatment.
      // Match that: only show a worked example once the combo actually
      // fired at least one application.
      if (evaluation.applications.length > 0) {
        const originalTotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
        comboPreview = {
          originalTotal,
          discountedTotal: originalTotal - evaluation.netSavings,
        };
      }
    }
  }

  const recurrenceDayLabels = (daysOfWeek ?? []).flatMap(day => {
    const key = DAY_KEYS[day];
    return key ? [t(`promotionWizard.validity.day.${key}`)] : [];
  });

  /** Combo slot summary line: joined names of the slot's own product/category targets. */
  function slotTargetsSummary(slot: SlotDraft): string {
    const names = [
      ...slot.productIds.flatMap(id => {
        const p = (products ?? []).find(x => x.id === id);
        return p ? [p.name] : [];
      }),
      ...slot.categoryIds.flatMap(id => {
        const c = (categories ?? []).find(x => x.id === id);
        return c ? [c.name] : [];
      }),
    ];
    return names.length > 0 ? names.join(', ') : t('promotionWizard.review.combo.noTargets');
  }

  function comboPricingSentence(): string {
    const value = comboPricing.value;
    switch (comboPricing.type) {
      case 'percent':
        return t('promotionWizard.review.combo.pricingPercent', { value });
      case 'fixed':
        return t('promotionWizard.review.combo.pricingFixed', {
          amount: formatMoney(Number(value) || 0),
        });
      case 'cheapest_free':
        return t('promotionWizard.review.combo.pricingCheapestFree', { count: value });
      case 'bundle_price':
      default:
        return t('promotionWizard.review.combo.pricingBundle', {
          amount: formatMoney(Number(value) || 0),
        });
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('promotionWizard.review.nameLabel')}</span>
          <span className="font-medium">{name || '—'}</span>
        </div>
        {isCombo ? (
          <>
            <div className="flex justify-between gap-4 text-sm">
              <span className="shrink-0 text-muted-foreground">
                {t('promotionWizard.review.combo.compositionLabel')}
              </span>
              <span className="flex flex-col items-end gap-0.5 text-right font-medium">
                {slots.map(slot => (
                  <span key={slot.key}>
                    {t('promotionWizard.review.combo.slotLine', {
                      quantity: slot.quantity,
                      targets: slotTargetsSummary(slot),
                    })}
                  </span>
                ))}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {t('promotionWizard.review.combo.pricingLabel')}
              </span>
              <span className="font-medium">{comboPricingSentence()}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {t('promotionWizard.review.discountLabel')}
              </span>
              <span className="font-medium">
                {discountType === 'percent'
                  ? t('promotionWizard.review.percentValue', { value: displayDiscountValue })
                  : formatMoney(displayDiscountValue)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('promotionWizard.review.scopeLabel')}</span>
              <span className="font-medium">
                {storeWide
                  ? t('promotionsListPanel.scopeStoreWide')
                  : t('promotionsListPanel.scopeTargetCounts', {
                      productCount: selectedProductIds.length,
                      categoryCount: selectedCategoryIds.length,
                    })}
              </span>
            </div>
          </>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {t('promotionWizard.review.dateRangeLabel')}
          </span>
          <span className="font-medium">
            {t('promotionWizard.review.dateRangeValue', { from: fromStr, to: toStr })}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {t('promotionWizard.review.recurrenceLabel')}
          </span>
          {recurring ? (
            <span className="flex flex-wrap justify-end gap-1 text-right font-medium">
              {recurrenceDayLabels.map(label => (
                <span key={label}>{label}</span>
              ))}
              {startTime !== null && endTime !== null && (
                <span>{t('promotionWizard.review.timeWindowValue', { startTime, endTime })}</span>
              )}
            </span>
          ) : (
            <span className="font-medium">{t('promotionWizard.review.noRecurrence')}</span>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
        {isCombo ? (
          comboPreview ? (
            <p className="text-sm">
              {t('promotionWizard.review.combo.previewLabel', {
                originalPrice: formatMoney(comboPreview.originalTotal),
                discountedPrice: formatMoney(comboPreview.discountedTotal),
              })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('promotionWizard.review.combo.noPreview')}
            </p>
          )
        ) : preview && sampleProduct ? (
          <p className="text-sm">
            {t('promotionWizard.review.previewLabel', {
              productName: sampleProduct.name,
              originalPrice: formatMoney(sampleProduct.basePrice),
              discountedPrice: formatMoney(preview.discountedUnitPrice),
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('promotionWizard.review.noPreview')}</p>
        )}
      </div>
    </div>
  );
}

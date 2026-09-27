import { useEffect, useState } from 'react';
import {
  useMutationCreatePromotion,
  useMutationUpdatePromotion,
  type Promotion,
} from '@entities/promotion';
import type { DiscountType, PromotionComboSlotInput, PromotionKind } from '@shared/lib/domain';
import type { Result } from '@shared/lib/result';

export type PromotionWizardStep = 'basics' | 'scope' | 'validity' | 'review';

export const WIZARD_STEP_ORDER: PromotionWizardStep[] = ['basics', 'scope', 'validity', 'review'];

/** One combo slot row in the wizard's in-progress (unsaved) state (Task 7). `key` is a client-only stable id — never sent to the server. */
export interface SlotDraft {
  key: string;
  quantity: number;
  label: string;
  productIds: string[];
  categoryIds: string[];
}

/** In-progress (string-buffered) combo pricing state — mirrors `discountPercentStr`'s raw-string convention; `Number()` applied once, at validate/save time. */
export interface ComboPricingDraft {
  type: DiscountType;
  value: string;
}

const DEFAULT_COMBO_PRICING: ComboPricingDraft = { type: 'bundle_price', value: '0' };

function makeEmptySlot(): SlotDraft {
  return { key: crypto.randomUUID(), quantity: 1, label: '', productIds: [], categoryIds: [] };
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

function startOfDay(str: string): Date {
  return new Date(`${str}T00:00:00`);
}

function endOfDay(str: string): Date {
  return new Date(`${str}T23:59:59`);
}

function defaultToStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return toDateStr(d);
}

/**
 * Wizard state machine for the promotion create/edit flow (D-07/D-08/D-10).
 * Basics & Discount, Scope, and Validity & Recurrence are real, working
 * steps (28-01/28-03/28-04); the Review step's live-price preview lives in
 * StepReview.tsx (28-04 Task 3). `save()` writes the real junction-table +
 * recurrence shape via the entity mutations for both create and edit.
 */
export function usePromotionWizardState(promotion: Promotion | null | undefined) {
  const [currentStep, setCurrentStep] = useState<PromotionWizardStep>('basics');
  const [furthestValidStep, setFurthestValidStep] = useState(0);

  const [name, setName] = useState('');
  // Combo builder (Task 7). `kind` defaults to 'discount' and is immutable
  // once editing an existing promotion (enforced by the caller disabling the
  // segmented control — the hook itself doesn't need to know isEdit).
  const [kind, setKindState] = useState<PromotionKind>('discount');
  const [slots, setSlots] = useState<SlotDraft[]>([]);
  const [comboPricing, setComboPricingState] = useState<ComboPricingDraft>(DEFAULT_COMBO_PRICING);
  const [discountType, setDiscountType] = useState<DiscountType>('percent');
  const [discountValue, setDiscountValue] = useState(0);
  // String-buffered percent input (mirrors PromotionFormDialog/NearExpirySettingsTab):
  // raw string state, no per-keystroke Number() coercion. Number() applied
  // once, at validate/save time.
  const [discountPercentStr, setDiscountPercentStr] = useState('0');

  // Pitfall 1 note: this plain date-range default uses the SAME
  // browser-local startOfDay/endOfDay helpers PromotionFormDialog already
  // used for the (unchanged-in-this-task) date-range feature — never reuse
  // this pattern for recurrence, which Task 2 routes through
  // settings.general.timezone instead.
  const [fromStr, setFromStr] = useState(() => toDateStr(new Date()));
  const [toStr, setToStr] = useState(defaultToStr);

  // Scope step (D-01/D-08 partial — full 4-step gate lands in 28-04).
  // storeWide defaults true, matching the Plan-01 always-store-wide default
  // so existing behavior doesn't regress until the admin explicitly picks
  // targets.
  const [storeWide, setStoreWide] = useState(true);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);

  // Validity & Recurrence step (D-04/D-05/D-06/D-08). recurring off ->
  // daysOfWeek/startTime/endTime are always null (every-day/all-day, i.e.
  // no recurrence restriction at all).
  const [recurring, setRecurring] = useState(false);
  const [daysOfWeek, setDaysOfWeek] = useState<number[] | null>(null);
  const [startTime, setStartTime] = useState<string | null>(null);
  const [endTime, setEndTime] = useState<string | null>(null);

  const [nameError, setNameError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);

  const createMutation = useMutationCreatePromotion();
  const updateMutation = useMutationUpdatePromotion();
  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset the wizard to
       the promotion being edited (or blank, for create) each time the
       identity of `promotion` changes, mirroring PromotionFormDialog's
       existing open/promotion reset effect. */
    if (promotion) {
      setName(promotion.name);
      setKindState(promotion.kind);
      if (promotion.kind === 'combo') {
        setSlots(
          promotion.slots.map(s => ({
            key: crypto.randomUUID(),
            quantity: s.quantity,
            label: s.label ?? '',
            productIds: s.targets.filter(t => t.productId != null).map(t => t.productId as string),
            categoryIds: s.targets
              .filter(t => t.categoryId != null)
              .map(t => t.categoryId as string),
          }))
        );
        setComboPricingState({ type: promotion.discountType, value: String(promotion.discountValue) });
      } else {
        setSlots([]);
        setComboPricingState(DEFAULT_COMBO_PRICING);
      }
      setDiscountType(promotion.discountType);
      setDiscountValue(promotion.discountValue);
      setDiscountPercentStr(String(promotion.discountValue));
      setFromStr(toDateStr(promotion.startsAt));
      setToStr(toDateStr(promotion.endsAt));
      // D-01/D-08 prefill: zero targets = store-wide; otherwise split the
      // junction rows by which FK is non-null.
      if (promotion.targets.length === 0) {
        setStoreWide(true);
        setSelectedProductIds([]);
        setSelectedCategoryIds([]);
      } else {
        setStoreWide(false);
        setSelectedProductIds(
          promotion.targets.filter(t => t.productId != null).map(t => t.productId as string)
        );
        setSelectedCategoryIds(
          promotion.targets.filter(t => t.categoryId != null).map(t => t.categoryId as string)
        );
      }
      // D-04/D-05 prefill: recurring is on when EITHER a day-of-week
      // restriction or a time window was saved (matches isValidityStepValid's
      // own "empty means every day / all day" reading of null/empty state).
      const hasDaysOfWeek = promotion.daysOfWeek !== null && promotion.daysOfWeek.length > 0;
      const hasTimeWindow = promotion.startTime !== null && promotion.endTime !== null;
      setRecurring(hasDaysOfWeek || hasTimeWindow);
      setDaysOfWeek(promotion.daysOfWeek);
      // DB `time` columns may return "HH:MM:SS" — normalize to "HH:MM" for
      // the native <input type="time"> fields (mirrors
      // promotion-pricing.ts's own startTime/endTime.slice(0, 5) normalization).
      setStartTime(promotion.startTime !== null ? promotion.startTime.slice(0, 5) : null);
      setEndTime(promotion.endTime !== null ? promotion.endTime.slice(0, 5) : null);
      setFurthestValidStep(WIZARD_STEP_ORDER.length - 1);
    } else {
      setName('');
      setKindState('discount');
      setSlots([]);
      setComboPricingState(DEFAULT_COMBO_PRICING);
      setDiscountType('percent');
      setDiscountValue(0);
      setDiscountPercentStr('0');
      setFromStr(toDateStr(new Date()));
      setToStr(defaultToStr());
      setStoreWide(true);
      setSelectedProductIds([]);
      setSelectedCategoryIds([]);
      setRecurring(false);
      setDaysOfWeek(null);
      setStartTime(null);
      setEndTime(null);
      setFurthestValidStep(0);
    }
    setCurrentStep('basics');
    setNameError(null);
    setValueError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [promotion]);

  function handleDiscountTypeChange(next: DiscountType) {
    setDiscountType(next);
    if (next === 'percent') setDiscountPercentStr('0');
  }

  /**
   * Switches between a plain discount promotion and a combo (Task 7). A
   * no-op re-click of the already-active option is ignored — unlike
   * handleDiscountTypeChange's own reset-on-every-click behavior, resetting
   * an entire composed combo (multiple slots + multi-select choices) on an
   * accidental re-click of the same segment would be a much costlier data
   * loss than that single-field precedent, so this guards against it.
   * discount→combo (create or edit — edit disables the control entirely, so
   * this only ever fires in create mode) seeds one empty slot; combo→discount
   * clears the slots and resets comboPricing to the default. The top-level
   * scope state (storeWide/selectedProductIds/selectedCategoryIds) is
   * deliberately left untouched either way — it's simply not rendered while
   * kind is 'combo', so switching back to 'discount' restores it as-is.
   */
  function setKind(next: PromotionKind) {
    if (next === kind) return;
    setKindState(next);
    if (next === 'combo') {
      setSlots([makeEmptySlot()]);
    } else {
      setSlots([]);
      setComboPricingState(DEFAULT_COMBO_PRICING);
    }
  }

  /** Appends one empty slot to the combo composition. */
  function addSlot() {
    setSlots(prev => [...prev, makeEmptySlot()]);
  }

  /** Removes the slot matching `key`. */
  function removeSlot(key: string) {
    setSlots(prev => prev.filter(s => s.key !== key));
  }

  /** Merges `patch` into the slot matching `key`. */
  function updateSlot(key: string, patch: Partial<Omit<SlotDraft, 'key'>>) {
    setSlots(prev => prev.map(s => (s.key === key ? { ...s, ...patch } : s)));
  }

  /**
   * Merges `patch` into the in-progress combo pricing draft. Final-review
   * fix #9: switching the pricing TYPE alone (no `value` in the same patch —
   * i.e. the Select's onValueChange, which only ever sends `{ type }`)
   * resets `value` to '' — mirrors handleDiscountTypeChange's own
   * reset-on-type-change behavior on the discount-kind side of this same
   * dialog. Without this, a numeric value typed for one mode (e.g.
   * cheapest_free "2") silently carries over as a
   * technically-valid-but-almost-certainly-wrong value for the new mode
   * (bundle_price "$2"). A patch that sets `type` and `value` together
   * (e.g. test fixtures seeding both at once) is left as an explicit,
   * intentional value and is never reset.
   */
  function setComboPricing(patch: Partial<ComboPricingDraft>) {
    setComboPricingState(prev => {
      if (patch.type !== undefined && patch.type !== prev.type && patch.value === undefined) {
        return { ...prev, ...patch, value: '' };
      }
      return { ...prev, ...patch };
    });
  }

  /** Sum of every slot's quantity — the ceiling `cheapest_free` must stay strictly under. */
  function totalSlotQuantity(): number {
    return slots.reduce((sum, s) => sum + s.quantity, 0);
  }

  /**
   * Composition validity (Task 7): at least one slot, each with quantity in
   * 1..20 and at least one product or category target.
   */
  function isCompositionValid(): boolean {
    if (slots.length === 0) return false;
    return slots.every(
      s =>
        s.quantity >= 1 &&
        s.quantity <= 20 &&
        (s.productIds.length > 0 || s.categoryIds.length > 0)
    );
  }

  /**
   * Combo pricing validity (Task 7): bundle_price/fixed accept any positive
   * value; percent must be in (0, 100]; cheapest_free must be a positive
   * integer strictly less than the total quantity across every slot (a
   * cheapest_free combo must always leave at least one non-free unit,
   * mirroring the DB CHECK's own spirit).
   */
  function isComboPricingValid(): boolean {
    const value = Number(comboPricing.value);
    switch (comboPricing.type) {
      case 'percent':
        return value > 0 && value <= 100;
      case 'cheapest_free':
        return Number.isInteger(value) && value >= 1 && value < totalSlotQuantity();
      case 'bundle_price':
      case 'fixed':
        return value > 0;
    }
  }

  /**
   * Checking store-wide clears any selected targets (no other path can
   * repopulate them while the picker is disabled). Unchecking simply flips
   * the flag — by construction the arrays are already empty at that point
   * (see the Deviations-free precedent in CategoryTreePicker's own
   * single-value-clear-on-deselect behavior), so no prior selection is ever
   * silently restored.
   */
  function handleStoreWideChange(checked: boolean) {
    setStoreWide(checked);
    if (checked) {
      setSelectedProductIds([]);
      setSelectedCategoryIds([]);
    }
  }

  /** Wired directly to MultiSelectPicker's onChange shape. */
  function handleScopeSelectionChange(next: { productIds: string[]; categoryIds: string[] }) {
    setSelectedProductIds(next.productIds);
    setSelectedCategoryIds(next.categoryIds);
  }

  /** D-08 partial: forward-nav gate for the Scope step. */
  function isScopeStepValid(): boolean {
    return storeWide || selectedProductIds.length + selectedCategoryIds.length > 0;
  }

  /** Wired directly to DateRangePicker's onChange(fromStr, toStr) shape. */
  function handleDateRangeChange(nextFromStr: string, nextToStr: string) {
    setFromStr(nextFromStr);
    setToStr(nextToStr);
  }

  /**
   * Toggling recurring off clears daysOfWeek/startTime/endTime to null (no
   * other path can repopulate them while the recurrence fields are hidden) —
   * mirrors handleStoreWideChange's own "switching X clears stale Y"
   * convention.
   */
  function handleRecurringChange(checked: boolean) {
    setRecurring(checked);
    if (!checked) {
      setDaysOfWeek(null);
      setStartTime(null);
      setEndTime(null);
    }
  }

  /** Adds/removes `day` (0=Sunday..6=Saturday) from the daysOfWeek selection. */
  function toggleDayOfWeek(day: number) {
    setDaysOfWeek(prev => {
      const current = prev ?? [];
      return current.includes(day)
        ? current.filter(d => d !== day)
        : [...current, day].sort((a, b) => a - b);
    });
  }

  /**
   * Validates the Validity & Recurrence step (D-04/D-05/D-08). The date
   * range must not end before it starts. When recurring is on: a "Recurring"
   * toggle with nothing configured (no days, no time window) is invalid; an
   * explicit time window with endTime <= startTime is invalid (D-05,
   * same-day only); exactly one of startTime/endTime set (never both null,
   * never both set) is invalid — it can't form a real window and would
   * violate the DB's start/end-both-or-neither CHECK constraint. Only
   * daysOfWeek set (no time window), or only a time window set (no
   * daysOfWeek restriction), are both valid partial configurations — "no day
   * restriction" / "no time restriction" reads as "every day" / "all day".
   */
  function isValidityStepValid(): boolean {
    if (toStr < fromStr) return false;
    if (recurring) {
      const hasDays = (daysOfWeek?.length ?? 0) > 0;
      const hasStartTime = startTime !== null;
      const hasEndTime = endTime !== null;
      if (hasStartTime !== hasEndTime) return false;
      const hasTimeWindow = hasStartTime && hasEndTime;
      if (!hasDays && !hasTimeWindow) return false;
      if (startTime !== null && endTime !== null && endTime <= startTime) return false;
    }
    return true;
  }

  /**
   * Pure (no side effects) mirror of validateBasics(), for isStepValid().
   * Task 7: the percent/fixed discount-value check only applies to
   * kind === 'discount' — a combo promotion's Basics section doesn't render
   * those fields at all (its pricing is validated separately by
   * isComboPricingValid, in its own Pricing section).
   */
  function isBasicsStepValid(): boolean {
    if (!name.trim()) return false;
    if (kind === 'combo') return true;
    const percentValue = Number(discountPercentStr);
    if (discountType === 'percent' && (percentValue <= 0 || percentValue > 100)) return false;
    if (discountType === 'fixed' && discountValue <= 0) return false;
    return true;
  }

  /**
   * Full 4-step forward-nav gate dispatcher (D-08). 'review' is always
   * valid — nothing to validate on the summary step itself; Save either
   * succeeds or surfaces a server error.
   */
  function isStepValid(step: PromotionWizardStep): boolean {
    switch (step) {
      case 'basics':
        return isBasicsStepValid();
      case 'scope':
        return isScopeStepValid();
      case 'validity':
        return isValidityStepValid();
      case 'review':
        return true;
    }
  }

  /**
   * Validates the Basics & Discount step's fields (D-08 forward-nav gate).
   * Task 7: skips the percent/fixed discount-value check entirely when
   * kind === 'combo' — that section isn't rendered in combo mode, and combo
   * pricing has its own validator (isComboPricingValid) in its own section.
   */
  function validateBasics(): boolean {
    let hasError = false;
    if (!name.trim()) {
      // eslint-disable-next-line i18next/no-literal-string -- i18n key identifier (resolved by the caller via t(`promotionFormDialog.${nameError}`)), not UI copy
      setNameError('nameError');
      hasError = true;
    } else {
      setNameError(null);
    }
    if (kind === 'combo') {
      setValueError(null);
      return !hasError;
    }
    const percentValue = Number(discountPercentStr);
    if (discountType === 'percent' && (percentValue <= 0 || percentValue > 100)) {
      // eslint-disable-next-line i18next/no-literal-string -- i18n key identifier, not UI copy
      setValueError('discountPercentError');
      hasError = true;
    } else if (discountType === 'fixed' && discountValue <= 0) {
      // eslint-disable-next-line i18next/no-literal-string -- i18n key identifier, not UI copy
      setValueError('discountAmountError');
      hasError = true;
    } else {
      setValueError(null);
    }
    return !hasError;
  }

  async function save(): Promise<Result<Promotion | null>> {
    const percentValue = Number(discountPercentStr);
    const isCombo = kind === 'combo';
    const basics = {
      name: name.trim(),
      kind,
      // Task 7: a combo promotion's discount type/value come from
      // comboPricing (bundle_price/percent/fixed/cheapest_free), not the
      // Basics section's percent/fixed fields, which only apply to
      // kind === 'discount'.
      discountType: isCombo ? comboPricing.type : discountType,
      discountValue: isCombo
        ? Number(comboPricing.value)
        : discountType === 'percent'
          ? percentValue
          : discountValue,
      startsAt: startOfDay(fromStr),
      endsAt: endOfDay(toStr),
      // D-04/D-05: gated on `recurring` too (not just the raw field state)
      // as defense-in-depth — handleRecurringChange already clears these on
      // toggle-off, but save() shouldn't trust that path alone.
      daysOfWeek: recurring && daysOfWeek !== null && daysOfWeek.length > 0 ? daysOfWeek : null,
      startTime: recurring ? startTime : null,
      endTime: recurring ? endTime : null,
      active: promotion?.active ?? true,
      createdBy: promotion?.createdBy ?? null,
    };

    // D-01: storeWide -> [] (store-wide/no restriction); otherwise one row
    // per selected product/category, each with the other FK null. A combo
    // promotion always sends top-level targets as [] regardless of the
    // (preserved-but-hidden) scope state — a combo's only targets live on
    // its slots.
    const targets = isCombo
      ? []
      : storeWide
        ? []
        : [
            ...selectedProductIds.map(id => ({ productId: id, categoryId: null })),
            ...selectedCategoryIds.map(id => ({ productId: null, categoryId: id })),
          ];

    // Task 7: SlotDraft -> PromotionComboSlotInput (client-only `key` is
    // never sent; array order becomes `position` server-side via
    // saveComboSlots). Omitted entirely (not []) for a discount promotion —
    // PromotionCreate/UpdateSchema treat `slots` as optional and the entity
    // mutation layer defaults a missing value to [] itself.
    const slotsInput: PromotionComboSlotInput[] | undefined = isCombo
      ? slots.map(s => ({
          quantity: s.quantity,
          label: s.label ? s.label : null,
          targets: [
            ...s.productIds.map(id => ({ productId: id, categoryId: null })),
            ...s.categoryIds.map(id => ({ productId: null, categoryId: id })),
          ],
        }))
      : undefined;

    // exactOptionalPropertyTypes: only include `slots` at all when it's a
    // combo (an explicit `slots: undefined` key is not the same as omitting
    // the key entirely under this compiler flag).
    const slotsField = slotsInput ? { slots: slotsInput } : {};

    if (promotion) {
      // Edit mode now has a real Scope-step picker (28-03) — the selected
      // set (never omitted) always reflects the admin's current choice,
      // including an explicit `[]` for a promotion switched to store-wide.
      return updateMutation.mutateAsync({ id: promotion.id, ...basics, targets, ...slotsField });
    }
    return createMutation.mutateAsync({ ...basics, targets, ...slotsField });
  }

  return {
    currentStep,
    setCurrentStep,
    furthestValidStep,
    setFurthestValidStep,
    name,
    setName,
    kind,
    setKind,
    slots,
    addSlot,
    removeSlot,
    updateSlot,
    comboPricing,
    setComboPricing,
    isCompositionValid,
    isComboPricingValid,
    totalSlotQuantity,
    discountType,
    handleDiscountTypeChange,
    discountValue,
    setDiscountValue,
    discountPercentStr,
    setDiscountPercentStr,
    fromStr,
    toStr,
    handleDateRangeChange,
    storeWide,
    handleStoreWideChange,
    selectedProductIds,
    selectedCategoryIds,
    handleScopeSelectionChange,
    isScopeStepValid,
    recurring,
    handleRecurringChange,
    daysOfWeek,
    toggleDayOfWeek,
    startTime,
    setStartTime,
    endTime,
    setEndTime,
    isValidityStepValid,
    isStepValid,
    nameError,
    valueError,
    validateBasics,
    save,
    isPending,
  };
}

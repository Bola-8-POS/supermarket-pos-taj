import { useTranslation } from 'react-i18next';
import type { DiscountType } from '@shared/lib/domain';
import { FormField, Input, MoneyInput } from '@shared/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import type { ComboPricingDraft } from '../../model/usePromotionWizardState';

export interface ComboPricingSectionProps {
  comboPricing: ComboPricingDraft;
  onChange: (patch: Partial<ComboPricingDraft>) => void;
  /** True once the admin tried to submit while the pricing value was invalid. */
  showValidationError: boolean;
  /**
   * Sum of every slot's quantity (wizard.totalSlotQuantity()) — needed here
   * only to distinguish a `cheapest_free` composition problem (too few total
   * slot units to ever satisfy "N free, at least 1 not free") from a plain
   * invalid-value error (final-review fix #7).
   */
  totalSlotQuantity: number;
  disabled?: boolean;
}

// Fixed pricing-mode enum order for the dropdown — not UI copy (each label is t()-wrapped below).
// eslint-disable-next-line i18next/no-literal-string -- domain enum literals, not UI copy
const PRICING_TYPES: DiscountType[] = ['bundle_price', 'percent', 'fixed', 'cheapest_free'];

const MONEY_TYPES = new Set<DiscountType>(['bundle_price', 'fixed']);

/**
 * Pricing step of the combo builder (Task 7): how the combo itself is
 * discounted once every slot is filled — a total bundle price, a percent or
 * fixed amount off the bundle, or N of the picked units free. Presentational
 * only, mirroring StepScope/StepValidityRecurrence's own useTranslation +
 * props-only-for-data convention.
 */
export function ComboPricingSection({
  comboPricing,
  onChange,
  showValidationError,
  totalSlotQuantity,
  disabled = false,
}: ComboPricingSectionProps) {
  const { t } = useTranslation('wAdmin');
  const isMoneyType = MONEY_TYPES.has(comboPricing.type);
  const numericValue = Number(comboPricing.value);
  // Final-review fix #7: cheapest_free needs `value < totalSlotQuantity`, so
  // a total of 1 (or 0) unit across every slot makes it mathematically
  // unsatisfiable for any value >= 1 — that's a COMPOSITION problem (not
  // enough slot quantity), not a bad pricing value, so it gets its own
  // message rather than the generic "enter a valid value" one.
  const isCheapestFreeUnsatisfiable =
    comboPricing.type === 'cheapest_free' && totalSlotQuantity <= 1;

  return (
    <div className="space-y-4">
      <FormField label={t('promotionDialog.pricing.typeLabel')} required>
        <Select
          value={comboPricing.type}
          disabled={disabled}
          onValueChange={val => {
            onChange({ type: val as DiscountType });
          }}
        >
          <SelectTrigger data-testid="combo-pricing-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRICING_TYPES.map(type => (
              <SelectItem key={type} value={type}>
                {t(`promotionDialog.pricing.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {isMoneyType ? (
        <FormField label={t(`promotionDialog.pricing.valueLabel.${comboPricing.type}`)} required>
          <MoneyInput
            value={Number.isFinite(numericValue) ? numericValue : 0}
            onChange={value => {
              onChange({ value: String(value) });
            }}
            disabled={disabled}
            data-testid="combo-pricing-value"
          />
        </FormField>
      ) : (
        <FormField label={t(`promotionDialog.pricing.valueLabel.${comboPricing.type}`)} required>
          <Input
            type="number"
            inputMode="decimal"
            min={comboPricing.type === 'cheapest_free' ? 1 : 0}
            {...(comboPricing.type === 'percent' ? { max: 100 } : {})}
            value={comboPricing.value}
            disabled={disabled}
            data-testid="combo-pricing-value"
            onChange={e => {
              onChange({ value: e.target.value });
            }}
          />
        </FormField>
      )}

      <p className="text-sm text-muted-foreground">
        {t(`promotionDialog.pricing.help.${comboPricing.type}`)}
      </p>

      {showValidationError && (
        <p className="text-sm text-destructive" role="alert">
          {isCheapestFreeUnsatisfiable
            ? t('promotionDialog.pricing.cheapestFreeNeedsMoreSlots')
            : t('promotionDialog.pricing.validationError')}
        </p>
      )}
    </div>
  );
}

/**
 * The payment form's money arithmetic, in one place so the form and the re-ring discount seed
 * (`reRingSeed.ts`) can never round differently. These are the form's own expressions, moved
 * here unchanged: do not "tidy" the rounding order, it decides half-cent ties.
 */
import { round2 } from '@entities/promotion';

/** One line of the form's tab as it is charged: unit price plus modifiers, times quantity. */
export function calculateLineTotal(item: {
  unitPrice: number;
  modifierPriceDelta: number;
  quantity: number;
}): number {
  return (item.unitPrice + item.modifierPriceDelta) * item.quantity;
}

/** Subtotal less an ad-hoc discount and combo savings, to the cent. */
export function afterDiscountAmount(
  subtotal: number,
  discount: number,
  comboSavings: number
): number {
  return round2(subtotal - discount - comboSavings);
}

export function saleTaxAmount(
  afterDiscount: number,
  taxRatePercent: number,
  taxInclusive: boolean
): number {
  if (taxInclusive) {
    // Inclusive mode (TAX-02): afterDiscount already IS the total — decompose
    // subtotal by division first, then derive tax by subtraction (never
    // re-derive independently — avoids a 1-cent drift vs. the total).
    const decomposedSubtotal = round2(afterDiscount / (1 + taxRatePercent / 100));
    return round2(afterDiscount - decomposedSubtotal);
  }
  // Exclusive mode (TAX-03): unchanged additive math.
  return round2(afterDiscount * (taxRatePercent / 100));
}

export function saleTotal(afterDiscount: number, taxAmount: number, taxInclusive: boolean): number {
  return taxInclusive ? afterDiscount : round2(afterDiscount + taxAmount);
}

/** What the form shows as the total for a subtotal, a fixed pre-tax discount and combo savings. */
export function formTotal(
  subtotal: number,
  discount: number,
  comboSavings: number,
  taxRatePercent: number,
  taxInclusive: boolean
): number {
  const after = afterDiscountAmount(subtotal, discount, comboSavings);
  return saleTotal(after, saleTaxAmount(after, taxRatePercent, taxInclusive), taxInclusive);
}

import { formTotal } from './saleTotals';

export interface ReRingSeedInput {
  /** Today's subtotal before tax, before any ad-hoc discount and before combo savings. */
  base: number;
  /** Combo savings the form takes off at the same stage as the discount. */
  comboSavings?: number;
  /** What the customer paid. */
  paid: number;
  taxRatePercent: number;
  taxInclusive: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The fixed discount that brings a re-ring's total down to what the customer paid (Ruling 11b:
 * the recorded sale equals what they paid). The form takes a fixed discount off BEFORE tax, so in
 * a tax-exclusive store the amount is the pre-tax one. Every total is computed with the form's
 * own arithmetic (`saleTotals.ts`), so what is returned is what the form will show. When the
 * cents cannot meet exactly it picks the amount whose total is the closest NOT ABOVE `paid`.
 * `total` is what the form will show with that discount applied. null: nothing to discount.
 */
export function reRingDiscountSeed(input: ReRingSeedInput): { amount: number; total: number } | null {
  const { base, comboSavings = 0, paid, taxRatePercent, taxInclusive } = input;
  const ideal = taxInclusive ? paid : paid / (1 + taxRatePercent / 100);
  // total is non-decreasing in the pre-tax amount: walk down from just above the ideal until it fits
  for (let cents = Math.round(ideal * 100) + 3; cents >= 0; cents -= 1) {
    const amount = round2(base - comboSavings - cents / 100);
    const total = formTotal(base, amount, comboSavings, taxRatePercent, taxInclusive);
    if (total > paid) continue;
    return amount > 0 && amount <= base ? { amount, total } : null;
  }
  return null;
}

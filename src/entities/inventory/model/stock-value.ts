/**
 * Value of stock on hand. Weighed (sold-by-weight) stock is held in grams while
 * cost_price is per kilogram (orchestrator ruling, owner to confirm), so the
 * product is scaled by 1/1000. Unit stock is quantity x cost. Unrounded: callers
 * round their own totals.
 */
export function stockValue(quantity: number, cost: number, soldByWeight: boolean): number {
  return soldByWeight ? (quantity * cost) / 1000 : quantity * cost;
}

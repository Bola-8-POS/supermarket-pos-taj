/**
 * Pure functions for prep batch consumption preview (no I/O).
 */

export function computePrepConsumption(
  qtyProduced: number,
  recipeItems: Array<{ ingredientId: string; qty: number }>,
  yieldQty: number,
): Array<{ ingredientId: string; delta: number }> {
  return recipeItems.map(item => ({
    ingredientId: item.ingredientId,
    delta: -(qtyProduced * item.qty) / yieldQty,
  }));
}

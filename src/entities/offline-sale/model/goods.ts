/* eslint-disable i18next/no-literal-string -- grouping-key separators, not UI copy. */

/** The part of a sale line that says WHICH goods leave the shelf; price and notes are not part of it. */
export type GoodsLine = {
  productId: string;
  quantity: number;
  modifierIds: readonly string[];
  weightGrams?: number | null | undefined;
};

/** Quantity per (product, sorted modifiers, weight): merged lines add up, order disappears. */
function goodsTally(lines: readonly GoodsLine[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.productId}|${[...l.modifierIds].sort().join(',')}|${String(l.weightGrams ?? '')}`;
    tally.set(key, (tally.get(key) ?? 0) + l.quantity);
  }
  return tally;
}

/**
 * Two-mode Plan 02b: do two baskets hold the same goods? Used to bind a manager-approved re-ring
 * to the sale it replaces. Price is deliberately NOT compared: a re-ring is rung at today's
 * prices, which differ from the offline ones by design.
 */
export function sameGoods(a: readonly GoodsLine[], b: readonly GoodsLine[]): boolean {
  const left = goodsTally(a);
  const right = goodsTally(b);
  if (left.size !== right.size) return false;
  for (const [key, quantity] of left) if (right.get(key) !== quantity) return false;
  return true;
}

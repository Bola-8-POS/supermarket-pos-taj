/**
 * combo-pricing.ts
 *
 * Pure combo-matching algorithm (R-06, spec section A.4). Mirrored (not
 * literally shared, see promotion-pricing.ts's own header for the same
 * caveat) in process_direct_sale_atomic's plpgsql combo pass — that SQL
 * version is the sole pricing authority at checkout; this TS version drives
 * the live cart preview and the client's expectedTotal.
 *
 * Zero imports beyond the Promotion type and promotion-pricing.ts's shared
 * `isPromotionLiveAt`/`round2` helpers — independently unit-testable.
 */
import type { DiscountType, Promotion, PromotionComboSlot } from '@shared/lib/domain';
import { isPromotionLiveAt, round2 } from './promotion-pricing';

export interface ComboCartLine {
  tempId: string;
  productId: string;
  categoryId: string;
  quantity: number;
  /** base + modifier delta */
  unitPrice: number;
  /** per-line promo/expiry savings already applied (0 if none) */
  lineDiscountPerUnit: number;
  soldByWeight: boolean;
  /** product flag only; category-chain eligibility is resolved via `isProductComboEligible`. */
  comboEligible: boolean;
}

/** One entry per consumed unit — a qty-N line can appear here N times, split across outcomes. */
export interface ComboUnitAllocation {
  tempId: string;
  discountAmount: number;
}

export interface ComboApplication {
  promotionId: string;
  promotionName: string;
  discountType: DiscountType;
  discountRate: number | null;
  units: ComboUnitAllocation[];
  gross: number;
  net: number;
}

export interface ComboEvaluation {
  applications: ComboApplication[];
  netSavings: number;
}

/** Minimal category shape needed for the eligibility/ancestor walk — avoids importing the full Category domain type. */
export interface ComboCategoryLookup {
  comboEligible: boolean;
  parentId: string | null | undefined;
}

/** Hard ceiling matching the DB's max category depth-3 constraint (root → child → grandchild). */
const MAX_CATEGORY_CHAIN_DEPTH = 3;

/** The greedy best-net loop never applies more combos than this to one cart, per spec A.4. */
const MAX_APPLICATIONS = 50;

/**
 * A product's own category plus up to its two ancestors (self, parent,
 * grandparent — matching the DB's max-depth-3 constraint), stopping early if
 * a lookup is missing. Order: nearest-to-farthest. Exported so callers
 * outside this module (e.g. StepReview's worked-example resolver) can match
 * a category-scoped slot target the same ancestor-chain way `matchesSlot`
 * does here, instead of re-deriving their own (potentially divergent) rule.
 */
export function getCategoryChain(
  categoryId: string,
  categoriesById: Map<string, ComboCategoryLookup>
): string[] {
  const chain: string[] = [];
  let current: string | null | undefined = categoryId;
  let depth = 0;
  while (current != null && depth < MAX_CATEGORY_CHAIN_DEPTH) {
    chain.push(current);
    const category = categoriesById.get(current);
    if (category == null) break; // missing lookup — don't crash, just stop climbing
    current = category.parentId;
    depth += 1;
  }
  return chain;
}

/**
 * A product can fill a combo slot only if it, AND every category in its
 * chain up to 3 levels, is combo-eligible. A category missing from the map
 * is treated as eligible (never hides a product just because a category
 * lookup is absent).
 */
export function isProductComboEligible(
  product: { comboEligible: boolean; categoryId: string },
  categoriesById: Map<string, ComboCategoryLookup>
): boolean {
  if (!product.comboEligible) return false;
  const chain = getCategoryChain(product.categoryId, categoriesById);
  for (const categoryId of chain) {
    const category = categoriesById.get(categoryId);
    if (category != null && !category.comboEligible) return false;
  }
  return true;
}

/**
 * A category can fill a combo slot (as a category-wide target) only if it,
 * AND every ancestor up to 3 levels, is combo-eligible. Same chain-walk as
 * `isProductComboEligible`, minus the leading product-level check. A
 * category missing from the map is treated as eligible (never hides a
 * category just because its own lookup is absent).
 */
export function isCategoryChainEligible(
  categoryId: string,
  categoriesById: Map<string, ComboCategoryLookup>
): boolean {
  const chain = getCategoryChain(categoryId, categoriesById);
  for (const chainId of chain) {
    const category = categoriesById.get(chainId);
    if (category != null && !category.comboEligible) return false;
  }
  return true;
}

/** Internal expanded unit — one per physical item, tracking enough to match/allocate/tie-break. */
interface ComboUnit {
  tempId: string;
  productId: string;
  categoryChain: string[];
  price: number;
  lineDiscountPerUnit: number;
  eligible: boolean;
  /** Ascending original position across the whole expansion — the tie-break key throughout. */
  index: number;
  consumed: boolean;
}

/** Expands cart lines into one unit per quantity count, preserving line input order then within-line order (Weight-sold lines never participate). */
function expandUnits(
  lines: ComboCartLine[],
  categoriesById: Map<string, ComboCategoryLookup>
): ComboUnit[] {
  const units: ComboUnit[] = [];
  let index = 0;
  for (const line of lines) {
    if (line.soldByWeight) continue;
    const eligible = isProductComboEligible(
      { comboEligible: line.comboEligible, categoryId: line.categoryId },
      categoriesById
    );
    const categoryChain = getCategoryChain(line.categoryId, categoriesById);
    for (let i = 0; i < line.quantity; i++) {
      units.push({
        tempId: line.tempId,
        productId: line.productId,
        categoryChain,
        price: line.unitPrice,
        lineDiscountPerUnit: line.lineDiscountPerUnit,
        eligible,
        index,
        consumed: false,
      });
      index += 1;
    }
  }
  return units;
}

function matchesSlot(unit: ComboUnit, slot: PromotionComboSlot): boolean {
  return slot.targets.some(
    t =>
      (t.productId != null && t.productId === unit.productId) ||
      (t.categoryId != null && unit.categoryChain.includes(t.categoryId))
  );
}

/**
 * Attempts to fill every slot of one combo from currently-free (unconsumed,
 * eligible) units: for each slot (processed in `position` order), the
 * `quantity` highest-priced matching candidates are taken (tie-break:
 * earliest original unit index). Fails (returns null) — for the whole
 * combo — the moment any slot can't be filled.
 */
function tryFillCombo(combo: Promotion, units: ComboUnit[]): ComboUnit[] | null {
  const claimed = new Set<ComboUnit>();
  const slotsInOrder = [...combo.slots].sort((a, b) => a.position - b.position);

  for (const slot of slotsInOrder) {
    const candidates = units.filter(
      u => !u.consumed && !claimed.has(u) && u.eligible && matchesSlot(u, slot)
    );
    if (candidates.length < slot.quantity) return null;

    candidates.sort((a, b) => b.price - a.price || a.index - b.index);
    for (let i = 0; i < slot.quantity; i++) {
      const unit = candidates[i];
      if (unit === undefined) return null; // unreachable given the length check above
      claimed.add(unit);
    }
  }

  return [...claimed];
}

/** Tolerance for float-vs-cent comparisons after repeated `round2` passes. */
const EPSILON = 1e-9;

/**
 * Prices one already-filled application: computes `gross` (the table in
 * spec A.1) and the per-unit allocation, in the same pass so the two can
 * never drift apart (`Σ allocation === gross` always holds by construction).
 * Returns `null` when pricing turns out to be impossible for this
 * application (see the bundle_price/fixed overflow-guard below) — the
 * caller treats that exactly like a failed `tryFillCombo` (skip this
 * candidate this round).
 */
function priceApplication(
  combo: Promotion,
  pickedUnits: ComboUnit[]
): { gross: number; allocations: ComboUnitAllocation[] } | null {
  if (combo.discountType === 'percent') {
    // Deliberate deviation from spec A.1's literal `round2(Σunit × value/100)`
    // wording: gross here is the SUM of the already-rounded per-unit amounts,
    // not an independently-rounded total. This is required so
    // `Σ allocations === gross` holds exactly (the floor-guard/parity
    // contract needs that), and it's what Task 4's plpgsql port must mirror.
    const allocations = pickedUnits.map(u => ({
      tempId: u.tempId,
      discountAmount: round2((u.price * combo.discountValue) / 100),
    }));
    const gross = round2(allocations.reduce((sum, a) => sum + a.discountAmount, 0));
    return { gross, allocations };
  }

  if (combo.discountType === 'cheapest_free') {
    const sorted = [...pickedUnits].sort((a, b) => a.price - b.price || a.index - b.index);
    const freeCount = Math.min(Math.max(Math.trunc(combo.discountValue), 0), sorted.length);
    const freeSet = new Set(sorted.slice(0, freeCount));
    const allocations = pickedUnits.map(u => ({
      tempId: u.tempId,
      discountAmount: freeSet.has(u) ? u.price : 0,
    }));
    const gross = round2(allocations.reduce((sum, a) => sum + a.discountAmount, 0));
    return { gross, allocations };
  }

  // bundle_price | fixed — proportional to unit price, rounded to 2dp,
  // remainder on the last unit (ascending original unit index) so the
  // allocated total always equals gross exactly. The naive per-unit
  // proportional amount is provably <= that unit's own price (gross <=
  // sumPrice by construction), but the *remainder* dumped onto the last
  // unit is not bounded by its price — a cheap trailing unit can be handed
  // more than it costs. Clamp every unit to its own price and push any
  // resulting overflow back onto earlier units' remaining headroom
  // (ascending index), so the total allocated still equals gross exactly.
  const sumPrice = pickedUnits.reduce((sum, u) => sum + u.price, 0);
  const gross =
    combo.discountType === 'bundle_price'
      ? round2(sumPrice - combo.discountValue)
      : round2(Math.min(combo.discountValue, sumPrice));

  const ordered = [...pickedUnits].sort((a, b) => a.index - b.index);
  const amounts = new Map<ComboUnit, number>();
  let runningSum = 0;
  ordered.forEach((u, i) => {
    if (i === ordered.length - 1) {
      amounts.set(u, round2(gross - runningSum));
    } else {
      const amount = sumPrice > 0 ? round2((gross * u.price) / sumPrice) : 0;
      runningSum += amount;
      amounts.set(u, amount);
    }
  });

  // Clamp every unit to its own price (in practice only the remainder-
  // bearing last unit can ever overflow, but every unit is swept
  // defensively), collecting the overflow as a residual to redistribute.
  let residual = 0;
  for (const u of ordered) {
    const amount = amounts.get(u) ?? 0;
    if (amount > u.price + EPSILON) {
      residual = round2(residual + (amount - u.price));
      amounts.set(u, u.price);
    }
  }

  if (residual > EPSILON) {
    for (const u of ordered) {
      if (residual <= EPSILON) break;
      const headroom = round2(u.price - (amounts.get(u) ?? 0));
      if (headroom <= EPSILON) continue;
      const add = Math.min(headroom, residual);
      amounts.set(u, round2((amounts.get(u) ?? 0) + add));
      residual = round2(residual - add);
    }
  }

  if (residual > EPSILON) {
    // Unreachable given gross <= sumPrice by construction — total headroom
    // across the application always covers any remainder. If this ever
    // trips, gross itself was invalid for this application; treat it as no
    // application rather than silently over-allocating past a unit's price.
    return null;
  }

  const allocations = pickedUnits.map(u => ({
    tempId: u.tempId,
    discountAmount: amounts.get(u) ?? 0,
  }));
  return { gross, allocations };
}

/**
 * Evaluates every applicable combo promotion against the cart, greedily
 * picking the best-net candidate each round until none clears net > 0 or 50
 * applications are reached (spec A.4). Combo candidates are pre-filtered to
 * `kind === 'combo'` + `isPromotionLiveAt` and tried in `createdAt` DESC
 * order (stable — ties keep input order) each round, for determinism.
 */
export function evaluateCombos(
  lines: ComboCartLine[],
  promotions: Promotion[],
  now: Date,
  timezone: string,
  categoriesById: Map<string, ComboCategoryLookup>
): ComboEvaluation {
  const units = expandUnits(lines, categoriesById);
  const combos = promotions
    .filter(p => p.kind === 'combo' && isPromotionLiveAt(p, now, timezone))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const applications: ComboApplication[] = [];

  while (applications.length < MAX_APPLICATIONS) {
    let best: {
      combo: Promotion;
      pickedUnits: ComboUnit[];
      gross: number;
      net: number;
      allocations: ComboUnitAllocation[];
    } | null = null;

    for (const combo of combos) {
      const pickedUnits = tryFillCombo(combo, units);
      if (pickedUnits === null) continue;

      const priced = priceApplication(combo, pickedUnits);
      if (priced === null) continue;
      const { gross, allocations } = priced;
      const lineDiscountSum = pickedUnits.reduce((sum, u) => sum + u.lineDiscountPerUnit, 0);
      const net = round2(gross - lineDiscountSum);
      if (net <= 0) continue;

      if (best === null || net > best.net) {
        best = { combo, pickedUnits, gross, net, allocations };
      }
    }

    if (best === null) break;

    for (const u of best.pickedUnits) u.consumed = true;
    applications.push({
      promotionId: best.combo.id,
      promotionName: best.combo.name,
      discountType: best.combo.discountType,
      discountRate: best.combo.discountType === 'percent' ? best.combo.discountValue : null,
      units: best.allocations,
      gross: best.gross,
      net: best.net,
    });
  }

  const netSavings = round2(applications.reduce((sum, a) => sum + a.net, 0));
  return { applications, netSavings };
}

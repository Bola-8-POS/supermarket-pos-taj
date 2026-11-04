import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { weightedLinePrice, type ComboCartLine, type ComboEvaluation } from '@entities/promotion';
import type { CartItem, Product, Modifier } from '@shared/lib/domain';
import { CartItemSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { ReRingMarkerSchema, type ReRingMarker } from '@shared/lib/offline-sale-schema';
/* eslint-disable i18next/no-literal-string -- zustand persist store name below
   is a localStorage key, not UI copy. */

interface CartState {
  items: CartItem[];
  heldCart: CartItem[] | null;
  /**
   * Live combo-promotion evaluation for the current `items` (Task 5) — a
   * derived, transient view of the cart, never persisted and always reset
   * whenever `items` is replaced wholesale (clearCart/holdCart/resumeHeld).
   */
  comboResult: ComboEvaluation | null;
  /**
   * The in-flight checkout idempotency key for the current `items` cart
   * (offline-first Plan 01, Task 6), persisted alongside it so a killed app
   * can retry the *same* attempt after restart instead of minting a new key
   * the server has never seen. `pendingIdempotencyFingerprint` is a
   * deterministic snapshot of the sale-defining content (items/discount)
   * the key was minted for — useCheckoutSale only reuses the key when the
   * cart's current fingerprint still matches; otherwise the cart changed
   * and a fresh key must be minted (process_direct_sale_atomic replays a
   * known key unconditionally, without comparing items/totals, so the
   * client must never resend a stale key against different cart content).
   * Survives a successful sale (cleared only once the cart itself is reset,
   * not the instant the RPC returns ok — a restart/navigate-away before
   * Done must still replay, not re-charge) and whenever the cart is
   * abandoned/replaced (clearCart/holdCart/resumeHeld below) or emptied by
   * an in-place edit (removeItem/updateQuantity/setLineQuantity taking the
   * last line to zero) — never on an edit that leaves the cart non-empty,
   * which must keep the key so a lost-response retry with the same content
   * still uses it.
   */
  pendingIdempotencyKey: string | null;
  pendingIdempotencyFingerprint: string | null;
  /**
   * Set while this cart is a manager's re-sale of an offline sale the server refused (two-mode
   * Plan 02b, Task 6b). Persisted with the cart so a restart cannot lose the link to the old
   * record; kept across edits that leave lines in the cart; dropped with the cart itself
   * (clearCart, holdCart, resumeHeld, or the last line removed). Abandoning the cart abandons the
   * re-ring: the record stays in review.
   */
  reRing: ReRingMarker | null;
}

interface CartActions {
  /**
   * Adds a product to the cart with the chosen modifiers.
   * If an identical product+modifier combination already exists, increments quantity instead.
   * Pass unitPrice to override the base price (e.g. happy hour resolved price).
   */
  addItem: (
    product: Product,
    modifiers: Modifier[],
    unitPrice?: number,
    promotionId?: string | null
  ) => void;

  /**
   * Adds a distinct gram-priced line; weighted products never merge.
   * The server prices a loose-weight line first and discounts the LINE, so pass the
   * promotion-resolved LINE total as `lineTotalOverride` (from `resolveProductPromotion` with the
   * weight); the line keeps the catalog per-kg price as its unitPrice. Without it the line is
   * priced at the catalog price.
   */
  addWeightedItem: (
    product: Product,
    weightGrams: number,
    lineTotalOverride?: number,
    promotionId?: string | null
  ) => void;

  /**
   * Reprices one weighted line for a new weight without changing its position in the cart.
   * `lineTotalOverride` is the promotion-resolved line total for the NEW weight (the caller
   * resolves it); without one the line is at the catalog price and carries no promotion.
   */
  updateWeightedItem: (
    tempId: string,
    weightGrams: number,
    lineTotalOverride?: number,
    promotionId?: string | null
  ) => void;

  /** Removes a cart line by its tempId. */
  removeItem: (tempId: string) => void;

  /** Updates the notes field on a cart line. */
  setItemNotes: (tempId: string, notes: string) => void;

  /**
   * Adjusts the quantity of a cart line by delta (+1 or -1).
   * Removes the line if quantity would drop to zero.
   */
  updateQuantity: (tempId: string, delta: 1 | -1) => void;

  /** Sets absolute quantity (1–99). Removes the line if quantity is 0 or less. */
  setLineQuantity: (tempId: string, quantity: number) => void;

  /**
   * Reconnect conflict resolution (PROMO-08): applies a freshly-evaluated
   * price/promotion to a flagged line and clears priceConflict. Never called
   * automatically — only in response to the cashier reviewing the line.
   * For a weighted line `newUnitPrice` is the fresh LINE total (unitPrice stays per kg).
   */
  resolveConflict: (tempId: string, newUnitPrice: number, newPromotionId: string | null) => void;

  /**
   * Reconnect conflict detection (PROMO-08): flags a line whose promotion
   * changed or vanished while offline. Never touches unitPrice/lineTotal —
   * a stale price is never silently re-applied.
   */
  flagPriceConflict: (tempId: string) => void;

  /** Empties the cart. */
  clearCart: () => void;

  holdCart: () => void;
  resumeHeld: () => void;
  discardHeld: () => void;

  /** Stores the latest combo-promotion evaluation for the current cart (Task 5). */
  setComboResult: (result: ComboEvaluation | null) => void;

  /**
   * Persists the checkout idempotency key together with the fingerprint of
   * the cart content it was minted for (Task 6). Call whenever a fresh key
   * is minted or an override key is used, so a restart can tell whether the
   * persisted key still matches the current cart.
   */
  setPendingIdempotencyKey: (key: string, fingerprint: string) => void;

  /**
   * Clears the persisted checkout idempotency key + fingerprint. Called
   * directly by clearCart/holdCart/resumeHeld. removeItem/updateQuantity/
   * setLineQuantity (when they empty the cart) and the persist `merge`
   * rehydration path (when persisted items fail validation and fall back to
   * an empty cart) don't call this action itself — they apply the same
   * null-out via the shared `idempotencyPatchIfEmptied` helper inline.
   * Never cleared on checkout success itself, which must let the key
   * survive until the cart is actually reset.
   */
  clearPendingIdempotencyKey: () => void;

  /** Marks (or unmarks) the cart as a re-ring of an offline sale. Set together with filling the cart. */
  setReRing: (marker: ReRingMarker | null) => void;
}

interface CartSelectors {
  /** Sum of all line totals in the cart. */
  totalAmount: () => number;

  /** Total number of individual units across all cart lines. */
  itemCount: () => number;

  /** True when the cart has no items. */
  isCartEmpty: () => boolean;

  /** Net savings from the last combo evaluation, or 0 when none. */
  comboNetSavings: () => number;
}

type CartStore = CartState & CartActions & CartSelectors;

const calcLineTotal = (unitPrice: number, modifiers: Modifier[], quantity: number): number =>
  (unitPrice + modifiers.reduce((sum, m) => sum + m.priceDelta, 0)) * quantity;

export const calcWeightedLineTotal = weightedLinePrice;

/** A weighed line is one weighing: quantity is always 1 (a line total already covers the weight). */
const clampWeighed = (items: CartItem[]): CartItem[] =>
  items.map(item => (item.weightGrams != null && item.quantity !== 1 ? { ...item, quantity: 1 } : item));

/** The cart as the combo evaluation sees it (CheckoutPanel feeds this to `evaluateCombos`). */
export function cartItemsToComboLines(items: readonly CartItem[]): ComboCartLine[] {
  return items.map(item => {
    const modifierDelta = item.selectedModifiers.reduce((sum, m) => sum + m.priceDelta, 0);
    return {
      tempId: item.tempId,
      productId: item.product.id,
      categoryId: item.product.categoryId,
      quantity: item.quantity,
      unitPrice: item.product.basePrice + modifierDelta,
      lineDiscountPerUnit: Math.max(0, item.product.basePrice - item.unitPrice),
      soldByWeight: item.weightGrams != null,
      comboEligible: item.product.comboEligible,
    };
  });
}

/**
 * A line-level mutation (removeItem / updateQuantity / setLineQuantity) that
 * leaves the cart empty must abandon whatever sale attempt the persisted
 * idempotency key belonged to, exactly like clearCart() does (opus
 * re-review, F2 round 1, Important). Without this, a restored paid cart
 * emptied one line at a time instead of via "Clear cart" keeps its stale
 * key+fingerprint; the next customer ringing up an identical cart produces
 * the same fingerprint, so the key is reused and process_direct_sale_atomic
 * silently replays the old (already-paid) sale — no new sale recorded, no
 * stock decrement, and the caja comes up short by that amount.
 */
function idempotencyPatchIfEmptied(items: CartItem[]): Partial<CartState> {
  return items.length === 0
    ? { pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null, reRing: null }
    : {};
}

/**
 * Local-storage key for the one persisted held-cart slot (D-01). Bump
 * HELD_CART_STORE_VERSION and extend `migrate` below on any future
 * incompatible change to CartItemSchema's persisted shape.
 */
const HELD_CART_STORE_NAME = 'direct-sale-held-cart';
const HELD_CART_STORE_VERSION = 2;

const PersistedHeldCartSchema = z.array(CartItemSchema).nullable();
const PersistedItemsSchema = z.array(CartItemSchema);
const PersistedPendingIdempotencyValueSchema = z.string().nullable();

/**
 * Validates a raw persisted `heldCart` value before it re-enters the store.
 * A missing, malformed, or tampered payload resolves to `null` (no held
 * cart) rather than a partial/incomplete cart — restart recovery must never
 * surface a sale that can't be trusted (T-02-09-01).
 */
function normalizePersistedHeldCart(value: unknown): CartItem[] | null {
  const parsed = PersistedHeldCartSchema.safeParse(value ?? null);
  if (!parsed.success) {
    logger.warn('cart.held.persisted_payload_invalid', { issueCount: parsed.error.issues.length });
    return null;
  }
  return parsed.data === null ? null : clampWeighed(parsed.data);
}

/**
 * Validates a raw persisted `items` value before it re-enters the store.
 * `undefined` (pre-upgrade localStorage with no `items` key yet) is treated
 * as "nothing to restore" and resolves silently to `[]`; a present but
 * malformed/tampered payload also falls back to `[]` rather than surfacing a
 * partial cart, same trust rule as `heldCart` above (T-02-09-01).
 */
function normalizePersistedItems(value: unknown): CartItem[] {
  if (value === undefined) {
    return [];
  }
  const parsed = PersistedItemsSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn('cart.items.persisted_payload_invalid', { issueCount: parsed.error.issues.length });
    return [];
  }
  return clampWeighed(parsed.data);
}

/**
 * Validates the raw persisted `{ pendingIdempotencyKey, pendingIdempotencyFingerprint }`
 * pair before it re-enters the store (Task 6). A key without its matching
 * fingerprint (or vice versa) is a corrupt/partial pair — normalizePersisted*
 * resolves it to "no pending attempt" (both null) rather than risk reusing a
 * key useCheckoutSale can't actually verify the fingerprint of, same trust
 * rule as heldCart/items above (T-02-09-01).
 */
function normalizePersistedPendingIdempotency(
  keyValue: unknown,
  fingerprintValue: unknown
): { pendingIdempotencyKey: string | null; pendingIdempotencyFingerprint: string | null } {
  const keyParsed = PersistedPendingIdempotencyValueSchema.safeParse(keyValue ?? null);
  const fingerprintParsed = PersistedPendingIdempotencyValueSchema.safeParse(fingerprintValue ?? null);
  const key = keyParsed.success ? keyParsed.data : null;
  const fingerprint = fingerprintParsed.success ? fingerprintParsed.data : null;
  if ((key === null) !== (fingerprint === null)) {
    logger.warn('cart.pending_idempotency.persisted_payload_invalid');
    return { pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null };
  }
  return { pendingIdempotencyKey: key, pendingIdempotencyFingerprint: fingerprint };
}

/**
 * Validates the raw persisted re-ring marker. A malformed one resolves to `null` (an ordinary
 * cart): the marker only ever adds a link, so losing a corrupt one is safe, and the record stays
 * in review. `idempotencyPatchIfEmptied` drops it again when the items did not survive.
 */
function normalizePersistedReRing(value: unknown): ReRingMarker | null {
  if (value === undefined || value === null) return null;
  const parsed = ReRingMarkerSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn('cart.rering.persisted_payload_invalid');
    return null;
  }
  return parsed.data;
}

/**
 * `heldCart` and the active `items` cart both persist (see `partialize`
 * below) so a restart never drops an in-progress sale — actions and derived
 * selectors remain session-only.
 */
export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      heldCart: null,
      comboResult: null,
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      reRing: null,

      addItem: (product, modifiers, unitPrice?, promotionId?) => {
        const state = get();
        const modifierKey = modifiers
          .map(m => m.id)
          .sort()
          .join(',');
        // A promotion snapshot is stamped only when an unitPrice override is
        // actually supplied (unitPrice !== undefined) — a plain re-add with
        // no override must not manufacture a "not promotion-sourced" stamp
        // out of nothing (PROMO-08).
        const promotionSnapshot =
          unitPrice !== undefined
            ? { promotionId: promotionId ?? null, discountSnapshotAt: Date.now() }
            : {};

        const existingIndex = state.items.findIndex(
          item =>
            item.weightGrams == null && // a second weighing is a new line, never quantity 2
            item.product.id === product.id &&
            item.selectedModifiers
              .map(m => m.id)
              .sort()
              .join(',') === modifierKey
        );

        if (existingIndex >= 0) {
          const updated = [...state.items];
          const existing = updated[existingIndex];
          if (!existing) {
            return;
          }
          const quantity = existing.quantity + 1;
          updated[existingIndex] = {
            ...existing,
            quantity,
            lineTotal: calcLineTotal(existing.unitPrice, existing.selectedModifiers, quantity),
            ...promotionSnapshot,
          };
          logger.debug('cart.item.incremented', { tempId: existing.tempId, quantity });
          set({ items: updated });
        } else {
          const resolvedUnitPrice = unitPrice ?? product.basePrice;
          const newItem: CartItem = {
            tempId: crypto.randomUUID(),
            product,
            quantity: 1,
            selectedModifiers: modifiers,
            unitPrice: resolvedUnitPrice,
            notes: '',
            lineTotal: calcLineTotal(resolvedUnitPrice, modifiers, 1),
            ...promotionSnapshot,
          };
          logger.debug('cart.item.added', { tempId: newItem.tempId, productId: product.id });
          set({ items: [...state.items, newItem] });
        }
      },

      addWeightedItem: (product, weightGrams, lineTotalOverride?, promotionId?) => {
        const promotionSnapshot =
          lineTotalOverride !== undefined
            ? { promotionId: promotionId ?? null, discountSnapshotAt: Date.now() }
            : {};
        const newItem: CartItem = {
          tempId: crypto.randomUUID(),
          product,
          quantity: 1,
          weightGrams,
          selectedModifiers: [],
          unitPrice: product.basePrice,
          notes: '',
          lineTotal: lineTotalOverride ?? calcWeightedLineTotal(product.basePrice, weightGrams),
          ...promotionSnapshot,
        };
        logger.debug('cart.weighted_item.added', {
          tempId: newItem.tempId,
          productId: product.id,
          weightGrams,
        });
        set(state => ({ items: [...state.items, newItem] }));
      },

      updateWeightedItem: (tempId, weightGrams, lineTotalOverride?, promotionId?) => {
        set(state => ({
          items: state.items.map(item =>
            item.tempId === tempId
              ? {
                  ...item,
                  weightGrams,
                  lineTotal:
                    lineTotalOverride ?? calcWeightedLineTotal(item.product.basePrice, weightGrams),
                  ...(lineTotalOverride !== undefined
                    ? { promotionId: promotionId ?? null, discountSnapshotAt: Date.now() }
                    : { promotionId: null }),
                }
              : item
          ),
        }));
        logger.debug('cart.weighted_item.updated', { tempId, weightGrams });
      },

      removeItem: tempId => {
        logger.debug('cart.item.removed', { tempId });
        set(state => {
          const items = state.items.filter(item => item.tempId !== tempId);
          return { items, ...idempotencyPatchIfEmptied(items) };
        });
      },

      setItemNotes: (tempId, notes) => {
        const clamped = notes.slice(0, 200);
        set(state => ({
          items: state.items.map(item =>
            item.tempId === tempId ? { ...item, notes: clamped } : item
          ),
        }));
        logger.debug('cart.item.notes_set', { tempId });
      },

      updateQuantity: (tempId, delta) => {
        set(state => {
          const updated = state.items
            .map(item => {
              if (item.tempId !== tempId) return item;
              const quantity = item.quantity + delta;
              if (quantity <= 0) return null;
              return {
                ...item,
                quantity,
                lineTotal: calcLineTotal(item.unitPrice, item.selectedModifiers, quantity),
              };
            })
            .filter((item): item is CartItem => item !== null);
          logger.debug('cart.quantity.updated', { tempId, delta });
          return { items: updated, ...idempotencyPatchIfEmptied(updated) };
        });
      },

      setLineQuantity: (tempId, quantity) => {
        set(state => {
          // a weighed line is one weighing; its quantity is never edited
          if (state.items.some(item => item.tempId === tempId && item.weightGrams != null)) return state;
          if (quantity <= 0) {
            logger.debug('cart.quantity.removed_line', { tempId });
            const items = state.items.filter(item => item.tempId !== tempId);
            return { items, ...idempotencyPatchIfEmptied(items) };
          }
          const clamped = Math.min(99, Math.max(1, Math.floor(quantity)));
          const updated = state.items.map(item => {
            if (item.tempId !== tempId) return item;
            return {
              ...item,
              quantity: clamped,
              lineTotal: calcLineTotal(item.unitPrice, item.selectedModifiers, clamped),
            };
          });
          logger.debug('cart.quantity.set', { tempId, quantity: clamped });
          return { items: updated };
        });
      },

      resolveConflict: (tempId, newUnitPrice, newPromotionId) => {
        set(state => ({
          items: state.items.map(item => {
            if (item.tempId !== tempId) return item;
            // A weighted line keeps the catalog per-kg unitPrice; its fresh price is a line total.
            const weighted = item.weightGrams != null;
            const lineTotal = weighted
              ? newUnitPrice
              : calcLineTotal(newUnitPrice, item.selectedModifiers, item.quantity);
            return {
              ...item,
              unitPrice: weighted ? item.unitPrice : newUnitPrice,
              lineTotal,
              promotionId: newPromotionId,
              discountSnapshotAt: Date.now(),
              priceConflict: false,
            };
          }),
        }));
        logger.info('cart.item.conflict_resolved', { tempId, newUnitPrice, newPromotionId });
      },

      flagPriceConflict: tempId => {
        set(state => ({
          items: state.items.map(item =>
            item.tempId === tempId ? { ...item, priceConflict: true } : item
          ),
        }));
        logger.warn('cart.item.price_conflict_flagged', { tempId });
      },

      clearCart: () => {
        logger.info('cart.cleared');
        // A lost response on a re-ring leaves a sale that may exist on the server with this key as
        // the only trace of it; clearing then drops the link. Leave the evidence in the log.
        const { reRing, pendingIdempotencyKey } = get();
        if (reRing && pendingIdempotencyKey !== null) {
          logger.warn('cart.rering.cleared_with_pending_key', {
            saleId: reRing.saleId,
            pendingIdempotencyKey,
          });
        }
        // Task 6: clearing the cart abandons whatever sale attempt the
        // persisted idempotency key belonged to — the next submit must mint
        // a fresh one rather than replay a stale key against a new sale.
        set({
          items: [],
          comboResult: null,
          pendingIdempotencyKey: null,
          pendingIdempotencyFingerprint: null,
          reRing: null,
        });
      },

      holdCart: () => {
        const state = get();
        // D-01: one slot only. If a held sale already exists, do not replace it
        // — leave both the existing held cart and the current active cart
        // untouched. CheckoutPanel also disables the Hold control while
        // isHeld, but this guard is the authoritative check regardless of caller.
        if (state.heldCart !== null) {
          logger.warn('cart.held.blocked_slot_occupied');
          return;
        }
        // Parking the items would turn a re-ring into an ordinary cart that can still be paid:
        // the server would hold the sale and nothing would ever close the offline record.
        if (state.reRing !== null) {
          logger.warn('cart.held.blocked_rering', { saleId: state.reRing.saleId });
          return;
        }
        logger.info('cart.held');
        // Task 6: the active cart is being parked, not submitted — any
        // pending key belonged to the now-parked attempt and must not leak
        // into whatever the cashier rings up next on the now-empty cart.
        set({
          heldCart: state.items,
          items: [],
          comboResult: null,
          pendingIdempotencyKey: null,
          pendingIdempotencyFingerprint: null,
        });
      },

      resumeHeld: () => {
        let swappedActiveCart = false;
        set(state => {
          if (!state.heldCart) return state;
          if (state.reRing !== null) {
            logger.warn('cart.resume.blocked_rering', { saleId: state.reRing.saleId });
            return state;
          }
          swappedActiveCart = state.items.length > 0;
          return {
            items: clampWeighed(state.heldCart),
            heldCart: swappedActiveCart ? state.items : null,
            comboResult: null,
            // Task 6: the held cart becoming active is a different sale
            // attempt than whatever the outgoing active cart was mid-way
            // through — never carry its key over.
            pendingIdempotencyKey: null,
            pendingIdempotencyFingerprint: null,
          };
        });
        logger.info('cart.resumed', { swappedActiveCart });
      },

      discardHeld: () => {
        logger.info('cart.held.discarded');
        // Only the held slot is discarded — the active cart (and its own
        // pending idempotency key, if any) is untouched (Task 6).
        set({ heldCart: null });
      },

      setComboResult: result => {
        set({ comboResult: result });
      },

      setPendingIdempotencyKey: (key, fingerprint) => {
        set({ pendingIdempotencyKey: key, pendingIdempotencyFingerprint: fingerprint });
      },

      clearPendingIdempotencyKey: () => {
        set({ pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null });
      },

      setReRing: marker => {
        set({ reRing: marker });
      },

      totalAmount: () => get().items.reduce((sum, item) => sum + item.lineTotal, 0),

      itemCount: () => get().items.reduce((count, item) => count + item.quantity, 0),

      isCartEmpty: () => get().items.length === 0,

      comboNetSavings: () => get().comboResult?.netSavings ?? 0,
    }),
    {
      name: HELD_CART_STORE_NAME,
      version: HELD_CART_STORE_VERSION,
      // Never serialize other action-derived/session-only state — the
      // active cart, the one held-cart slot, and (Task 6) the in-flight
      // checkout idempotency key + the fingerprint it was minted for are
      // the only restart-recoverable fields.
      partialize: state => ({
        heldCart: state.heldCart,
        items: state.items,
        pendingIdempotencyKey: state.pendingIdempotencyKey,
        pendingIdempotencyFingerprint: state.pendingIdempotencyFingerprint,
        reRing: state.reRing,
      }),
      // Called only when the persisted version differs from
      // HELD_CART_STORE_VERSION. Version 1 (pre-Task-6) is a known shape —
      // its heldCart/items carry over unchanged and the new idempotency
      // fields default to null, so a version bump alone never drops a
      // restart-recoverable cart. Any other obsolete version has no defined
      // migration path, so it resolves to no held cart/items/key rather
      // than risking a shape mismatch downstream.
      migrate: (persistedState, version) => {
        if (version === HELD_CART_STORE_VERSION) {
          return persistedState as {
            heldCart: unknown;
            items: unknown;
            pendingIdempotencyKey: unknown;
            pendingIdempotencyFingerprint: unknown;
            reRing?: unknown;
          };
        }
        if (version === 1) {
          const legacy = persistedState as { heldCart?: unknown; items?: unknown };
          logger.info('cart.held.persisted_version_migrated', {
            fromVersion: version,
            toVersion: HELD_CART_STORE_VERSION,
          });
          return {
            heldCart: legacy.heldCart,
            items: legacy.items,
            pendingIdempotencyKey: null,
            pendingIdempotencyFingerprint: null,
          };
        }
        logger.warn('cart.held.persisted_version_obsolete', { version });
        return { heldCart: null, items: [], pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null };
      },
      // Runs on every hydration (including right after `migrate`) — the
      // single point that validates the payload against CartItemSchema
      // (and, for the idempotency pair, the corrupt-partial-pair check)
      // before it re-enters live state (T-02-09-01).
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | {
              heldCart?: unknown;
              items?: unknown;
              pendingIdempotencyKey?: unknown;
              pendingIdempotencyFingerprint?: unknown;
              reRing?: unknown;
            }
          | undefined;
        const reRing = normalizePersistedReRing(persisted?.reRing);
        // An unreadable marker means we no longer know this cart is a re-ring; its items would be
        // payable as an ordinary sale and the old record would never close. Drop both.
        const unreadableMarker =
          persisted?.reRing !== undefined && persisted.reRing !== null && reRing === null;
        const items = unreadableMarker ? [] : normalizePersistedItems(persisted?.items);
        return {
          ...currentState,
          heldCart: normalizePersistedHeldCart(persisted?.heldCart),
          items,
          ...normalizePersistedPendingIdempotency(
            persisted?.pendingIdempotencyKey,
            persisted?.pendingIdempotencyFingerprint
          ),
          reRing,
          // opus re-review, F2 round 2: items and the pending key/fingerprint
          // are validated independently above, so a well-formed key can
          // survive alongside items that failed CartItemSchema validation
          // and fell back to []. A key minted for a cart that no longer
          // exists must not outlive it — the next customer's identical cart
          // would otherwise reproduce the same fingerprint, reuse the stale
          // key, and silently replay the old (already-paid) sale. Spread
          // last so it overrides normalizePersistedPendingIdempotency's
          // result whenever items ended up empty.
          ...idempotencyPatchIfEmptied(items),
        };
      },
    }
  )
);

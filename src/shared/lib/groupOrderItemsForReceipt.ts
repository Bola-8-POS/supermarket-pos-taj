/**
 * Groups flat receipt/pre-cheque item rows into 2-level Category → Item
 * buckets (D-01), plus a modifier-line formatter shared by both text
 * builders (D-05).
 *
 * Pure functions, no I/O. Callers resolve category names before calling —
 * this module never fetches or joins against `categories`. The
 * uncategorized bucket (rows with no category) is always the LAST group in
 * the returned array. See `groupOrderItemsForReceipt.test.ts` for the full
 * contract (grouping, ordering, sanitization).
 */

import type { Locale } from '@shared/lib/domain';

/**
 * Row shape accepted by {@link groupByCategory} — the category fields it groups on.
 * Optional (not just nullable) so callers with an untouched `ReceiptData['items']`
 * element (`categoryId`/`categoryName` are `.optional()` in the Zod schema) satisfy
 * this constraint without an intermediate mapping step.
 */
export type CategorizedRow = {
  categoryId?: string | null | undefined;
  categoryName?: string | null | undefined;
};

/** One category bucket: resolved category identity plus its items, in input order. */
export type CategoryGroup<T> = {
  categoryId: string | null;
  categoryName: string | null;
  items: T[];
};

/** Sentinel map key for rows with no usable category (never exposed to callers). */
const UNCATEGORIZED_KEY = '__uncategorized__';

/**
 * Strips C0/C1 control characters (e.g. ESC/POS command bytes) and trims.
 * Exported (WR-04) so callers can sanitize the other free-text fields they
 * print through the same functions this module protects (item name/notes,
 * customer/cashier name, table label, bar name/address).
 */
export function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes (T-25-01)
  return s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
}

/**
 * Groups rows into category buckets, sorted by `categoryName` (locale
 * compare), with a single trailing uncategorized bucket (rows whose
 * `categoryId`/`categoryName` is null/undefined/empty, or whose
 * `categoryName` is entirely control characters) if any exist. Never
 * mutates the input array; preserves input order within each group.
 *
 * @param locale Optional locale for the category-name sort (`localeCompare`).
 * Defaults to the runtime's default locale (current behavior) when omitted.
 */
export function groupByCategory<T extends CategorizedRow>(
  rows: readonly T[],
  locale?: Locale
): CategoryGroup<T>[] {
  const map = new Map<string, CategoryGroup<T>>();

  for (const row of rows) {
    const catId = row.categoryId ?? null;
    // WR-01: sanitize before testing for emptiness — a raw `.trim()` doesn't
    // strip C0/C1 control bytes, so a control-byte-only name (e.g. "\x01")
    // would pass this check as non-empty even though sanitize() reduces it
    // to '' below, breaking the uncategorized-last invariant.
    const sanitizedName = sanitize(row.categoryName ?? '');
    const key = catId == null || !sanitizedName ? UNCATEGORIZED_KEY : catId;

    let group = map.get(key);
    if (!group) {
      group = {
        categoryId: key === UNCATEGORIZED_KEY ? null : catId,
        categoryName: key === UNCATEGORIZED_KEY ? null : sanitizedName,
        items: [],
      };
      map.set(key, group);
    }
    group.items.push(row);
  }

  const named: CategoryGroup<T>[] = [];
  let uncategorized: CategoryGroup<T> | undefined;
  for (const [key, group] of map) {
    if (key === UNCATEGORIZED_KEY) {
      uncategorized = group;
    } else {
      named.push(group);
    }
  }
  named.sort((a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '', locale));

  return uncategorized ? [...named, uncategorized] : named;
}

/**
 * Formats modifier names into the two-space plus-sign line convention
 * (`  + Extra cheese`). Empty/whitespace-only names are dropped.
 */
export function formatModifierLines(modifierNames: readonly string[]): string[] {
  const lines: string[] = [];
  for (const name of modifierNames) {
    const clean = sanitize(name);
    if (clean) lines.push(`  + ${clean}`);
  }
  return lines;
}

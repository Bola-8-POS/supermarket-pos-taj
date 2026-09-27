/**
 * Pure helpers for `ProductDetailDialog`'s error-driven tab navigation
 * (D-06) and dirty-close guard (D-07). No React, no Supabase — a plain
 * mapping table plus two small comparisons so both behaviours are testable
 * without mounting the dialog.
 */

export type ProductDialogTabId = 'details' | 'photo' | 'links';

/** Rail order (D-01) — ties in `firstErroringTab` resolve to this order. */
export const PRODUCT_DIALOG_TAB_ORDER: readonly ProductDialogTabId[] = [
  'details',
  'photo',
  'links',
];

/**
 * Field-to-tab mapping from 31-UI-SPEC.md § "Error navigation". Photo owns
 * no form field — the photo commits at upload time, not on Save — so it is
 * never a target of the D-06 auto-switch.
 */
const LINKS_FIELDS = new Set(['unitsPerPackage', 'parentProductId', 'modifiers', 'imageUrl']);

/**
 * Resolves a Zod field-error key to the tab that owns it. `_form` (a
 * form-level error) belongs to no tab. Details owns `name`, `categoryId`,
 * `basePrice`, `sku`, `barcode`, and `isActive` — and, deliberately, any
 * other unmapped key falls back to Details rather than being silently
 * unreachable.
 */
export function tabForFieldError(key: string): ProductDialogTabId | null {
  if (key === '_form') return null;
  if (LINKS_FIELDS.has(key)) return 'links';
  return 'details';
}

function erroringTabs(fieldErrors: Record<string, string>): Set<ProductDialogTabId> {
  const tabs = new Set<ProductDialogTabId>();
  for (const key of Object.keys(fieldErrors)) {
    const tab = tabForFieldError(key);
    if (tab) tabs.add(tab);
  }
  return tabs;
}

/** The first tab (by rail order) holding at least one field error, or `null` if none. */
export function firstErroringTab(fieldErrors: Record<string, string>): ProductDialogTabId | null {
  const tabs = erroringTabs(fieldErrors);
  for (const tab of PRODUCT_DIALOG_TAB_ORDER) {
    if (tabs.has(tab)) return tab;
  }
  return null;
}

/** Every tab holding at least one field error — drives the rail's error-dot badges. */
export function tabsWithErrors(fieldErrors: Record<string, string>): Set<ProductDialogTabId> {
  return erroringTabs(fieldErrors);
}

/**
 * Snapshot of the dialog's editable field state, used by the D-07
 * dirty-close guard. Photo changes are never part of this snapshot — they
 * commit at upload time and are already persisted by the time the dialog
 * closes.
 */
export type ProductFormSnapshot = {
  name: string;
  categoryId: string;
  basePrice: number;
  sku: string;
  barcode: string;
  unitsPerPackageInput: string;
  parentProductIdInput: string;
  isActive: boolean;
  comboEligible: boolean;
  imageUrl: string;
  modifierIds: string[];
  selectedSupplierIds: string[];
  /** Phase 32 D-07 dirty-close guard extension: brand + weight fields. */
  brandId: string;
  weightAmountInput: string;
  weightUnit: string;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sortedA = [...(a as string[])].sort();
    const sortedB = [...(b as string[])].sort();
    return sortedA.length === sortedB.length && sortedA.every((v, i) => v === sortedB[i]);
  }
  return a === b;
}

/** True when any field in `current` differs from its value in `initial`. */
export function isProductFormDirty(
  initial: ProductFormSnapshot,
  current: ProductFormSnapshot
): boolean {
  return (Object.keys(initial) as (keyof ProductFormSnapshot)[]).some(
    key => !sameValue(initial[key], current[key])
  );
}

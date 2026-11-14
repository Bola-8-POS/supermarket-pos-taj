/**
 * Assistant read model. Every read runs on the caller's own Supabase session, so server RLS stays the
 * authority (products_select_authenticated lets any signed-in role read the catalog, as the checkout lookup does).
 */
import {
  AssistantExpiryRowSchema,
  AssistantLowStockRowSchema,
  AssistantProductRowSchema,
  AssistantSalesSummaryRpcSchema,
  AssistantSupplierOptionSchema,
  NearExpirySettingsSchema,
  type AssistantExpiryRow,
  type AssistantLowStockRow,
  type AssistantProductRow,
  type AssistantSalesSummary,
  type AssistantSupplierOption,
} from '@shared/lib/domain';
import type { AssistantError } from '@shared/lib/local-assistant/proposal';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

/** Rows returned to the panel; the query asks for one more to learn whether the list was cut. */
export const LOOKUP_ROW_CAP = 10;

export type ProductLookupResult = { rows: AssistantProductRow[]; more: boolean };

type ProductRowDb = {
  id: string;
  name: string;
  base_price: number;
  barcode: string | null;
  shelf_location: string | null;
  updated_at: string;
  inventory: { quantity_on_hand: number } | { quantity_on_hand: number }[] | null;
};

const SELECT = 'id, name, base_price, barcode, shelf_location, updated_at, inventory(quantity_on_hand)';
const BARCODE = /^\d{8,14}$/;

/** `%`, `_` and `\` are LIKE wildcards/escapes: a typed `50%` must not match everything. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, c => `\\${c}`);

function toRow(row: ProductRowDb): AssistantProductRow | null {
  const inv = Array.isArray(row.inventory) ? row.inventory[0] : row.inventory;
  const parsed = AssistantProductRowSchema.safeParse({
    productId: row.id,
    name: row.name,
    price: row.base_price,
    quantityOnHand: inv ? inv.quantity_on_hand : null,
    barcode: row.barcode,
    shelfLocation: row.shelf_location,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

const unavailable = (): Result<never, AssistantError> => err({ code: 'DATA_UNAVAILABLE' });

/** Exact barcode first (digits only, 8-14 chars), otherwise a partial, case-insensitive name match. */
export async function productLookup(
  query: string,
  client: typeof supabase = supabase
): Promise<Result<ProductLookupResult, AssistantError>> {
  try {
    const q = query.trim();
    const base = () => client.from('products').select(SELECT).eq('is_active', true);

    if (BARCODE.test(q)) {
      const exact = await base().eq('barcode', q).limit(LOOKUP_ROW_CAP + 1);
      if (exact.error) {
        logger.warn('assistant.read.failed', { message: exact.error.message });
        return unavailable();
      }
      if (exact.data.length > 0) return ok(shape(exact.data as unknown as ProductRowDb[]));
    }

    const { data, error } = await base()
      .ilike('name', `%${escapeLike(q)}%`)
      .order('name')
      .limit(LOOKUP_ROW_CAP + 1);
    if (error) {
      logger.warn('assistant.read.failed', { message: error.message });
      return unavailable();
    }
    return ok(shape(data as unknown as ProductRowDb[]));
  } catch (e) {
    logger.warn('assistant.read.failed', { message: e instanceof Error ? e.message : 'unknown' });
    return unavailable();
  }
}

function shape(data: ProductRowDb[]): ProductLookupResult {
  const rows = data.slice(0, LOOKUP_ROW_CAP).flatMap(r => {
    const row = toRow(r);
    return row ? [row] : [];
  });
  return { rows, more: data.length > LOOKUP_ROW_CAP };
}

/** Rows returned for the expiry list; the query asks for one more to learn whether the list was cut. */
export const EXPIRY_ROW_CAP = 25;

export type ExpiryListResult = { rows: AssistantExpiryRow[]; more: boolean };

const DEFAULT_THRESHOLD_DAYS = 14;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Calendar date (YYYY-MM-DD) of `base` plus `addDays` in the till's local timezone (America/Mexico_City at Taj),
 * the same day the near-expiry alert uses. Built from local components, never `toISOString()`, which is UTC and
 * would roll the date forward for an evening sale (L8).
 */
function localDate(base: Date, addDays: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays);
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD); UTC arithmetic so DST never shifts the count. */
function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

type ExpiryRowDb = { expiry_date: string | null; product: { id: string; name: string } | null };

/**
 * Products whose expiry date is on or before today + `withinDays` (already expired included, as in the
 * near-expiry alert), soonest first. `withinDays` null = the store's near_expiry threshold, default 14.
 */
export async function expiryList(
  withinDays: number | null,
  client: typeof supabase = supabase,
  now: Date = new Date()
): Promise<Result<ExpiryListResult, AssistantError>> {
  try {
    let days = withinDays;
    if (days === null) {
      const setting = await client.from('settings').select('value').eq('key', 'near_expiry').maybeSingle();
      if (setting.error) {
        logger.warn('assistant.read.failed', { message: setting.error.message });
        return unavailable();
      }
      const parsed = NearExpirySettingsSchema.safeParse(setting.data?.value);
      days = parsed.success ? parsed.data.thresholdDays : DEFAULT_THRESHOLD_DAYS;
    }

    const { data, error } = await client
      .from('inventory')
      .select('expiry_date, product:products!inner(id, name)')
      .eq('product.is_active', true)
      .not('expiry_date', 'is', null)
      .lte('expiry_date', localDate(now, days))
      .order('expiry_date')
      .limit(EXPIRY_ROW_CAP + 1);
    if (error) {
      logger.warn('assistant.read.failed', { message: error.message });
      return unavailable();
    }

    const today = localDate(now, 0);
    const dbRows = data as unknown as ExpiryRowDb[];
    const rows = dbRows.slice(0, EXPIRY_ROW_CAP).flatMap(r => {
      if (!r.product || !r.expiry_date) return [];
      const parsed = AssistantExpiryRowSchema.safeParse({
        productId: r.product.id,
        name: r.product.name,
        expiryDate: r.expiry_date,
        daysUntilExpiry: daysBetween(today, r.expiry_date),
      });
      return parsed.success ? [parsed.data] : [];
    });
    return ok({ rows, more: dbRows.length > EXPIRY_ROW_CAP });
  } catch (e) {
    logger.warn('assistant.read.failed', { message: e instanceof Error ? e.message : 'unknown' });
    return unavailable();
  }
}

/**
 * Today's sales / caja summary for this terminal. Goes through the definer RPC assistant_sales_summary, which
 * refuses callers whose role lacks `view_reports` (AUTH_FORBIDDEN) on the server; the registry refuses first on
 * the client. `get_caja_report` is never called directly because it has no role check of its own.
 */
export async function salesSummary(
  terminalId: string = getTerminalId(),
  client: typeof supabase = supabase
): Promise<Result<AssistantSalesSummary, AssistantError>> {
  try {
    const { data, error } = await client.rpc('assistant_sales_summary', { p_terminal_id: terminalId });
    if (error) {
      logger.warn('assistant.read.failed', { message: error.message });
      return unavailable();
    }
    const parsed = AssistantSalesSummaryRpcSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn('assistant.read.failed', { message: 'sales summary payload did not match the contract' });
      return unavailable();
    }
    const payload = parsed.data;
    if (!payload.ok) {
      if (payload.code === 'AUTH_FORBIDDEN' || payload.code === 'NO_CAJA') return err({ code: payload.code });
      return unavailable();
    }
    return ok({
      cajaId: payload.caja_id,
      openedAt: payload.opened_at,
      closedAt: payload.closed_at,
      summary: payload.report.summary,
    });
  } catch (e) {
    logger.warn('assistant.read.failed', { message: e instanceof Error ? e.message : 'unknown' });
    return unavailable();
  }
}

/** Rows returned for the low-stock list; the scan keeps a few more to learn whether the list was cut. */
export const LOW_STOCK_ROW_CAP = 25;
// ponytail: PostgREST cannot compare two columns, so low-stock is filtered client-side over the 1000 lowest-quantity
// inventory rows (one PostgREST page). Past 1000 low-ish SKUs, move the comparison into an RPC/view.
const LOW_STOCK_SCAN = 1000;
/** Supplier names offered as a typed choice when the typed query matches several. */
const SUPPLIER_CHOICES = 5;

export type LowStockTarget = { query: string | null } | { supplierId: string };
export type LowStockResult =
  | { type: 'rows'; rows: AssistantLowStockRow[]; more: boolean; supplierName: string | null }
  | { type: 'choose'; options: AssistantSupplierOption[] };

type LowStockRowDb = {
  product_id: string;
  quantity_on_hand: number;
  low_stock_threshold: number;
  product: { id: string; name: string } | null;
};

/**
 * Products at or below their own low-stock threshold, lowest stock first. With a supplier name that matches one
 * supplier the list is limited to that supplier's products (supplier_products, as the reorder suggestion does);
 * several matches return a typed choice, which the panel resolves by calling this again with `{ supplierId }`.
 */
export async function lowStock(
  target: LowStockTarget,
  client: typeof supabase = supabase
): Promise<Result<LowStockResult, AssistantError>> {
  try {
    let supplier: AssistantSupplierOption | null = null;
    if ('supplierId' in target || target.query !== null) {
      const base = client.from('suppliers').select('id, name');
      const found =
        'supplierId' in target
          ? await base.eq('id', target.supplierId).limit(1)
          : await base
              .ilike('name', `%${escapeLike(target.query ?? '')}%`)
              .order('name')
              .limit(SUPPLIER_CHOICES + 1);
      if (found.error) {
        logger.warn('assistant.read.failed', { message: found.error.message });
        return unavailable();
      }
      const options = found.data.flatMap(s => {
        const parsed = AssistantSupplierOptionSchema.safeParse(s);
        return parsed.success ? [parsed.data] : [];
      });
      if (options.length === 0) return err({ code: 'NOT_FOUND' });
      if (options.length > 1) return ok({ type: 'choose', options: options.slice(0, SUPPLIER_CHOICES) });
      supplier = options[0] ?? null;
    }

    let productIds: string[] | null = null;
    if (supplier) {
      const links = await client.from('supplier_products').select('product_id').eq('supplier_id', supplier.id);
      if (links.error) {
        logger.warn('assistant.read.failed', { message: links.error.message });
        return unavailable();
      }
      productIds = links.data.map(l => l.product_id);
      if (productIds.length === 0) return ok({ type: 'rows', rows: [], more: false, supplierName: supplier.name });
    }

    const inventory = client
      .from('inventory')
      .select('product_id, quantity_on_hand, low_stock_threshold, product:products!inner(id, name)')
      .eq('product.is_active', true);
    const { data, error } = await (productIds ? inventory.in('product_id', productIds) : inventory)
      .order('quantity_on_hand')
      .range(0, LOW_STOCK_SCAN - 1);
    if (error) {
      logger.warn('assistant.read.failed', { message: error.message });
      return unavailable();
    }

    const low = (data as unknown as LowStockRowDb[])
      .flatMap(r => {
        if (!r.product || r.quantity_on_hand > r.low_stock_threshold) return [];
        const parsed = AssistantLowStockRowSchema.safeParse({
          productId: r.product.id,
          name: r.product.name,
          quantityOnHand: r.quantity_on_hand,
          lowStockThreshold: r.low_stock_threshold,
        });
        return parsed.success ? [parsed.data] : [];
      })
      .sort((a, b) => a.quantityOnHand - b.quantityOnHand || a.name.localeCompare(b.name));
    return ok({
      type: 'rows',
      rows: low.slice(0, LOW_STOCK_ROW_CAP),
      more: low.length > LOW_STOCK_ROW_CAP,
      supplierName: supplier?.name ?? null,
    });
  } catch (e) {
    logger.warn('assistant.read.failed', { message: e instanceof Error ? e.message : 'unknown' });
    return unavailable();
  }
}

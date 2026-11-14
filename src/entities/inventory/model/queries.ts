/* eslint-disable i18next/no-literal-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { skipToken, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useSettings } from '@entities/settings';
import type {
  Inventory,
  InventoryAlert,
  NearExpiryAlert,
  NearExpiryPricingDate,
  Product,
  StockMovement,
} from '@shared/lib/domain';
import {
  CategorySchema,
  InventoryAlertSchema,
  NearExpiryAlertSchema,
  NearExpiryPricingDateSchema,
  ProductSchema,
  StockMovementSchema,
} from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
import { fetchAllRows } from '@shared/lib/fetch-all-rows';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { inventoryPollIntervalMs } from '@shared/lib/store-mode';
import { supabase } from '@shared/lib/supabase';
import type { Tables } from '@shared/lib/supabase.types';
import { useInventoryStore } from './store';
import { InventorySchema } from './types';

export const inventoryKeys = {
  all: ['inventory'] as const,
  product: (id: string) => [...inventoryKeys.all, 'product', id] as const,
  lowStock: () => [...inventoryKeys.all, 'low-stock'] as const,
  alerts: () => [...inventoryKeys.all, 'alerts'] as const,
  nearExpiry: (thresholdDays: number) => [...inventoryKeys.all, 'near-expiry', thresholdDays] as const,
  // The threshold the list was fetched for is part of the key: a list for another threshold is a different entry, never trusted.
  // An unknown threshold gets its own key: it must never resolve to a cached list for a real one.
  nearExpiryPricing: (thresholdDays: number | undefined) =>
    [...inventoryKeys.all, 'near-expiry-pricing', thresholdDays ?? 'unknown'] as const,
  log: (productId?: string) => [...inventoryKeys.all, 'log', productId ?? 'all'] as const,
};

type ProductJoined = Tables<'products'> & {
  category: Tables<'categories'> | null;
};

type InventoryRow = Tables<'inventory'> & {
  product: ProductJoined | null;
};

export function mapInventoryRow(row: InventoryRow): Result<Inventory> {
  try {
    let product: Product | undefined;
    if (row.product) {
      // Pre-type-regen workaround (CLAUDE.md): units_per_package /
      // parent_product_id aren't in supabase.types.ts yet, so `Tables<'products'>`
      // (ProductJoined's base) doesn't declare them even though the `products(*)`
      // select above returns them at runtime.
      const productRaw = row.product as unknown as Record<string, unknown>;
      const cat =
        row.product.category != null
          ? CategorySchema.parse({
              id: row.product.category.id,
              name: row.product.category.name,
              color: row.product.category.color,
              sortOrder: row.product.category.sort_order,
              // legacy HH start/end columns retired (Phase 20, D-01) — superseded
              // by the promotions engine; always null.
              happyHourStart: null,
              happyHourEnd: null,
              createdAt: new Date(row.product.category.created_at),
            })
          : undefined;
      product = ProductSchema.parse({
        id: row.product.id,
        name: row.product.name,
        categoryId: row.product.category_id,
        basePrice: row.product.base_price,
        // legacy HH price column retired (Phase 20, D-01) — superseded by the
        // promotions engine; always null.
        happyHourPrice: null,
        sku: row.product.sku,
        isActive: row.product.is_active,
        soldByWeight: productRaw['sold_by_weight'] === true,
        imageUrl: row.product.image_url,
        photoPath: (row.product as { photo_path?: string | null }).photo_path ?? null,
        stock_threshold: row.product.stock_threshold ?? null,
        // Phase 27: ProductSchema requires these two keys present (nullable,
        // not optional) — omitting them entirely (as this call site did
        // before) makes `undefined` fail `.nullable()` validation, which
        // throws inside mapInventoryRow's try/catch and poisons the WHOLE
        // /inventory list (useInventory() bails out on the first row that
        // fails to parse), not just rows for open-unit-configured products.
        unitsPerPackage: (productRaw['units_per_package'] as number | null | undefined) ?? null,
        parentProductId: (productRaw['parent_product_id'] as string | null | undefined) ?? null,
        // Phase 32: same rationale as unitsPerPackage/parentProductId above —
        // ProductSchema requires these keys present (nullable, not optional).
        brandId: (productRaw['brand_id'] as string | null | undefined) ?? null,
        weightAmount: (productRaw['weight_amount'] as number | null | undefined) ?? null,
        weightUnit: (productRaw['weight_unit'] as string | null | undefined) ?? null,
        modifiers: [],
        category: cat,
      });
    }

    return ok(
      InventorySchema.parse({
        id: row.id,
        productId: row.product_id,
        quantityOnHand: row.quantity_on_hand,
        lowStockThreshold: row.low_stock_threshold,
        unit: row.unit,
        costPrice: (row as unknown as { cost_price?: number | null }).cost_price ?? null,
        expiryDate: (row as unknown as { expiry_date?: string | null }).expiry_date ?? null,
        product,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

/** Every inventory row with its product, paged in full; the hook and the list test share it. */
export function fetchInventoryRows(client: typeof supabase) {
  return fetchAllRows((from, to) =>
    client
      .from('inventory')
      .select('*, product:products(*, category:categories(*))', { count: 'exact' })
      .order('product(name)')
      .order('id')
      .range(from, to)
  );
}

export function useInventory() {
  const query = useQuery({
    queryKey: inventoryKeys.all,
    queryFn: async (): Promise<Result<Inventory[]>> => {
      const res = await fetchInventoryRows(supabase);

      if (!res.ok) {
        logger.error('inventory.fetch_failed', { message: res.error.message });
        return res;
      }

      const list: Inventory[] = [];
      for (const row of res.data as InventoryRow[]) {
        const m = mapInventoryRow(row);
        if (!m.ok) {
          logger.error('inventory.map_failed', { message: m.error.message });
          return m;
        }
        list.push(m.data);
      }
      return ok(list);
    },
    staleTime: 60 * 1000,
  });

  useEffect(() => {
    if (query.data?.ok) {
      useInventoryStore.getState().setInventory(query.data.data);
    }
  }, [query.data]);

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

/**
 * Returns all products where stock_threshold is set and
 * current quantity_on_hand <= stock_threshold.
 *
 * Queries the inventory table joined with products, filtering server-side
 * to only rows where products.stock_threshold is not null, then applies
 * the <= threshold comparison client-side.
 *
 * Invalidated by the Realtime subscription in useInventoryStore.
 */
export function useInventoryAlerts() {
  const query = useQuery({
    queryKey: inventoryKeys.alerts(),
    queryFn: async (): Promise<Result<InventoryAlert[]>> => {
      // Select inventory joined with products; only include products that have
      // a stock_threshold configured (not null).
      const res = await supabaseQuery(() =>
        supabase
          .from('inventory')
          .select(
            `
            quantity_on_hand,
            product:products!inner(
              id,
              name,
              stock_threshold
            )
          `
          )
          .not('product.stock_threshold', 'is', null)
      );

      if (!res.ok) {
        logger.error('inventory.alerts.fetch_failed', { message: res.error.message });
        return res;
      }

      const alerts: InventoryAlert[] = [];

      // expiry_date was added in Phase 03 and awaits generated DB type refresh.
      for (const row of res.data as unknown as Array<{
        quantity_on_hand: number;
        product: { id: string; name: string; stock_threshold: number | null } | null;
      }>) {
        if (!row.product || row.product.stock_threshold === null) continue;

        const threshold = row.product.stock_threshold;
        if (row.quantity_on_hand > threshold) continue;

        try {
          alerts.push(
            InventoryAlertSchema.parse({
              productId: row.product.id,
              productName: row.product.name,
              currentStock: row.quantity_on_hand,
              threshold,
            })
          );
        } catch (e) {
          return err(unknownError(e));
        }
      }

      return ok(alerts);
    },
    staleTime: 30 * 1000,
    refetchInterval: inventoryPollIntervalMs(),
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

/** Returns products whose active expiry date falls within the configured window. */
export function useNearExpiryAlerts() {
  const { data: settings } = useSettings();
  const thresholdDays = settings?.nearExpiry.thresholdDays ?? 14;
  const query = useQuery({
    queryKey: inventoryKeys.nearExpiry(thresholdDays),
    queryFn: async (): Promise<Result<NearExpiryAlert[]>> => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() + thresholdDays);
      const res = await supabaseQuery(() =>
        supabase
          .from('inventory')
          .select('expiry_date, product:products!inner(id, name)')
          .not('expiry_date', 'is', null)
          .lte('expiry_date', cutoff.toISOString().slice(0, 10))
      );
      if (!res.ok) {
        logger.error('inventory.near_expiry.fetch_failed', { message: res.error.message });
        return res;
      }
      const alerts: NearExpiryAlert[] = [];
      // expiry_date was added in Phase 03 and awaits generated DB type refresh.
      for (const row of res.data as unknown as Array<{
        expiry_date: string | null;
        product: { id: string; name: string } | null;
      }>) {
        if (!row.product || !row.expiry_date) continue;
        try {
          const expiryDate = new Date(`${row.expiry_date}T00:00:00`);
          alerts.push(
            NearExpiryAlertSchema.parse({
              productId: row.product.id,
              productName: row.product.name,
              expiryDate: row.expiry_date,
              daysUntilExpiry: Math.ceil((expiryDate.getTime() - today.getTime()) / 86_400_000),
            })
          );
        } catch (e) {
          return err(unknownError(e));
        }
      }
      return ok(alerts);
    },
    staleTime: 30 * 1000,
  });
  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

/**
 * How far past the tier threshold the pricing list reaches. The persisted catalog may be up to
 * seven days old when a till sells offline (PERSIST_MAX_AGE_MS), and the day count is taken at
 * pricing time, so a product that is outside the tier when the list is fetched can be inside it
 * by the time it is used: seven days of entries, plus one because the store's date can run a day
 * ahead of the UTC date the cutoff below is cut on (store zones go up to UTC+14).
 */
export const NEAR_EXPIRY_PRICING_LOOKAHEAD_DAYS = 8;

/**
 * Product id + expiry date for every product that is, or within `LOOKAHEAD` days could become,
 * inside the near-expiry tier. The cutoff is a UTC date; the tier itself is decided on the store's
 * date (`daysUntilExpiryOn`), and the lookahead keeps the cutoff a superset for any zone.
 * `client` and `now` are parameters so the pricing-parity integration test can call exactly this.
 */
export async function fetchNearExpiryPricingDates(
  client: typeof supabase,
  thresholdDays: number,
  now: Date = new Date()
): Promise<Result<NearExpiryPricingDate[]>> {
  const cutoff = new Date(
    now.getTime() + (thresholdDays + NEAR_EXPIRY_PRICING_LOOKAHEAD_DAYS) * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const res = await fetchAllRows((from, to) =>
    client
      .from('inventory')
      .select('product_id, expiry_date', { count: 'exact' })
      .not('expiry_date', 'is', null)
      .lte('expiry_date', cutoff)
      .order('product_id')
      .range(from, to)
  );
  if (!res.ok) {
    logger.error('inventory.near_expiry_pricing.fetch_failed', { message: res.error.message });
    return res;
  }
  const rows: NearExpiryPricingDate[] = [];
  for (const row of res.data as unknown as Array<{ product_id: string; expiry_date: string | null }>) {
    if (!row.expiry_date) continue;
    try {
      rows.push(
        NearExpiryPricingDateSchema.parse({ productId: row.product_id, expiryDate: row.expiry_date })
      );
    } catch (e) {
      return err(unknownError(e));
    }
  }
  return ok(rows);
}

/**
 * The checkout's near-expiry PRICING source (`resolveProductPromotion`). Persisted for the offline
 * till (see queryPersister): expiry dates only, no stock figure. Staff-facing near-expiry lists keep
 * using `useNearExpiryAlerts`.
 */
/**
 * One definition of the pricing-list query, shared by the hook and the app-level warm-up. With no
 * threshold there is nothing to fetch (`skipToken`). A failed fetch throws, so TanStack's retry and
 * refetch-on-reconnect apply and the last good list stays in place (a resolved Err Result would
 * count as a fresh success for `staleTime`).
 */
const nearExpiryPricingQueryOptions = (thresholdDays: number | undefined) => {
  const queryFn =
    thresholdDays === undefined
      ? skipToken
      : async () => {
          const r = await fetchNearExpiryPricingDates(supabase, thresholdDays);
          if (!r.ok) throw new Error(r.error.message);
          return r;
        };
  return { queryKey: inventoryKeys.nearExpiryPricing(thresholdDays), queryFn, staleTime: 30 * 1000 } as const;
};

/**
 * Subscribes to the pricing list for the threshold in force, whenever it is known or changes while
 * `enabled` - not only once the checkout mounts. A real observer (not a one-off prefetch) keeps the
 * entry from being collected while signed in and lets a failed fetch retry. Without it a threshold
 * saved on /settings, followed by an outage before /pos opens, leaves no list for the new threshold.
 */
export function useWarmNearExpiryPricing(enabled: boolean): void {
  const { data: settings } = useSettings();
  useQuery({ ...nearExpiryPricingQueryOptions(settings?.nearExpiry.thresholdDays), enabled });
}

export function useNearExpiryPricingDates() {
  const { data: settings } = useSettings();
  const thresholdDays = settings?.nearExpiry.thresholdDays;
  // never fetches, nor reads a cached list, with a guessed threshold: the reach depends on the real setting
  const query = useQuery(nearExpiryPricingQueryOptions(thresholdDays));
  // No list is trusted unless it was fetched for the threshold in force (keyed above): after a
  // threshold change the hook has no data until the refetch lands - offline, never.
  const r = query.data;
  return { ...query, data: r?.ok ? r.data : undefined };
}

type AdjustInventoryContext = { previousList?: Result<Inventory[]> };

/**
 * One RPC (`adjust_inventory`) locks the stock row, checks `p_expected_quantity`
 * when given, updates `inventory`, and writes the `stock_movements` ledger row
 * and the audit row together — the caller is read from the session server-side,
 * so no `staffId` is threaded through here anymore.
 *
 * The idempotency key is bound to the attempt AND its target — a fingerprint
 * of `productId|quantityDelta|reason|expectedQuantity` (fix-pass F5, mirrors
 * useReopenTab.ts's `{ tabId, key }` ref from F4). A retry of the SAME
 * fingerprint reuses the key so a lost-response replay is safe; a DIFFERENT
 * adjustment (a different product, delta, or reason — the Batch Adjustment
 * dialog in StockTab.tsx keeps one hook instance alive for the whole tab, so
 * this happens on every new submit) always mints a fresh key instead of
 * colliding with whatever the previous attempt committed under. It's also
 * reset after a successful apply, on an IDEMPOTENCY_* rejection (see below),
 * and by the caller via `resetIdempotencyKey()` when a dialog closes.
 */
export function useMutationAdjustInventory() {
  const queryClient = useQueryClient();
  const idempotencyAttemptRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: async ({
      productId,
      quantityDelta,
      reason,
      notes,
    }: {
      productId: string;
      quantityDelta: number;
      reason: string;
      notes: string | undefined;
    }): Promise<Result<{ quantityOnHand: number; movementId: string }>> => {
      const fingerprint = `${productId}|${String(quantityDelta)}|${reason}|null`;
      if (idempotencyAttemptRef.current?.fingerprint !== fingerprint) {
        idempotencyAttemptRef.current = {
          fingerprint,
          // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
          key: generateIdempotencyKey('adjust_inventory'),
        };
      }
      const idempotencyKey = idempotencyAttemptRef.current.key;
      const rpcRes = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
           supabase.types.ts lags behind the adjust_inventory RPC (repo-wide cast pattern;
           no-explicit-any/no-unsafe-assignment/no-unsafe-member-access/no-unsafe-argument are
           already disabled at the top of this file). */
        (supabase as any).rpc('adjust_inventory', {
          p_product_id: productId,
          p_quantity_delta: quantityDelta,
          p_reason: reason,
          p_notes: notes ?? null,
          p_expected_quantity: null,
          p_idempotency_key: idempotencyKey,
        })
        /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
      );

      if (!rpcRes.ok) {
        const { message, detail, raw } = rpcRes.error;
        if (/^IDEMPOTENCY_/.test(message)) {
          // The earlier attempt under this key may already have committed on
          // the server before the response was lost — discard it so the very
          // next attempt (even an identical retry) mints a fresh key instead
          // of repeating this same mismatch forever (fix-pass F5, same
          // pattern as useReopenTab.ts/useProcessRefund.ts). Query
          // invalidation for this outcome runs uniformly in onSuccess below.
          idempotencyAttemptRef.current = undefined;
          logger.error('inventory.adjust.idempotency_replay', { message });
          return err({
            code: 'VALIDATION_ERROR',
            message: i18n.t('entities:inventoryAdjust.idempotencyReplay'),
            raw,
          });
        }
        if (message.includes('AUTH_FORBIDDEN')) {
          return err({ code: 'AUTH_FORBIDDEN', message, raw });
        }
        if (message.includes('INVALID_DELTA')) {
          return err({ code: 'INVALID_DELTA', message, raw });
        }
        if (message.includes('INVALID_REASON')) {
          return err({ code: 'INVALID_REASON', message, raw });
        }
        if (message.includes('STOCK_CHANGED')) {
          return err({ code: 'STOCK_CHANGED', message, raw });
        }
        if (message.includes('NOT_FOUND')) {
          return err({ code: 'NOT_FOUND', message, raw });
        }
        // The UPDATE inside adjust_inventory can fail its own CHECK
        // constraint (quantity_on_hand_non_negative, SQLSTATE 23514) rather
        // than the RPC's own INVALID_DELTA/STOCK_CHANGED guards — for
        // example a stale expected quantity race that still lands below
        // zero. parseSupabaseError already turns a 23514 into a generic
        // VALIDATION_ERROR with the raw constraint text folded into
        // `detail`; recognize that one constraint by name and report it
        // with the same readable code the rest of the app uses for a
        // negative-stock refusal instead of falling through to a raw
        // database message in the toast.
        if (detail?.includes('quantity_on_hand_non_negative')) {
          return err({ code: 'INVENTORY_NEGATIVE', message: 'This adjustment would take stock below zero.', raw });
        }
        logger.error('inventory.adjust.rpc_failed', { message });
        return rpcRes;
      }

      const data = rpcRes.data as { ok: boolean; quantityOnHand: number; movementId: string } | null;
      if (!data?.ok) {
        return err(unknownError('adjust_inventory_no_result'));
      }
      return ok({ quantityOnHand: data.quantityOnHand, movementId: data.movementId });
    },

    onMutate: async ({ productId, quantityDelta }) => {
      await queryClient.cancelQueries({ queryKey: inventoryKeys.all });
      const previousList = queryClient.getQueryData<Result<Inventory[]>>(inventoryKeys.all);
      useInventoryStore.setState(s => ({
        inventory: s.inventory.map(i =>
          i.productId === productId
            ? { ...i, quantityOnHand: Math.max(0, i.quantityOnHand + quantityDelta) }
            : i
        ),
      }));
      useInventoryStore.getState().refreshAlerts();
      queryClient.setQueryData<Result<Inventory[]>>(inventoryKeys.all, old => {
        if (!old?.ok) return old;
        return ok(
          old.data.map(i =>
            i.productId === productId
              ? { ...i, quantityOnHand: Math.max(0, i.quantityOnHand + quantityDelta) }
              : i
          )
        );
      });
      return { previousList } as AdjustInventoryContext;
    },

    onSuccess: (result, variables, ctx) => {
      const c = ctx as AdjustInventoryContext | undefined;
      const { productId } = variables;
      if (!result.ok) {
        if (c?.previousList !== undefined) {
          queryClient.setQueryData(inventoryKeys.all, c.previousList);
          if (c.previousList.ok) {
            useInventoryStore.getState().setInventory(c.previousList.data);
          }
        }
        // A failed or lost response can still mean the RPC committed on the
        // server (fix-pass F5) — refetch so the row shows what actually
        // happened instead of trusting the rolled-back optimistic snapshot.
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.log(productId) });
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.product(productId) });
        return;
      }
      idempotencyAttemptRef.current = undefined;
      const { quantityOnHand } = result.data;
      useInventoryStore.setState(s => ({
        inventory: s.inventory.map(i => (i.productId === productId ? { ...i, quantityOnHand } : i)),
      }));
      useInventoryStore.getState().refreshAlerts();
      queryClient.setQueryData<Result<Inventory[]>>(inventoryKeys.all, old => {
        if (!old?.ok) return old;
        return ok(old.data.map(i => (i.productId === productId ? { ...i, quantityOnHand } : i)));
      });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.log() });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.product(productId) });
    },

    onError: (_e, _v, ctx) => {
      const prev = ctx?.previousList;
      if (prev !== undefined) {
        queryClient.setQueryData(inventoryKeys.all, prev);
        if (prev.ok) useInventoryStore.getState().setInventory(prev.data);
      }
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
    },
  });

  return {
    ...mutation,
    /**
     * Discards the pending/committed idempotency key so the next adjustment
     * always mints a fresh one — call this when a dialog that keeps this
     * hook mounted (e.g. StockTab.tsx's Batch Adjustment dialog) closes, so a
     * much later identical adjustment is never absorbed as a replay of a
     * stale attempt (fix-pass F5, mirrors useReopenTab.ts).
     */
    resetIdempotencyKey: () => {
      idempotencyAttemptRef.current = undefined;
    },
  };
}

export function useInventoryLog(productId?: string) {
  const query = useQuery({
    queryKey: inventoryKeys.log(productId),
    queryFn: async (): Promise<Result<StockMovement[]>> => {
      const base = supabase
        .from('stock_movements')
        .select(
          `
          *,
          product:products(
            id,
            name,
            sku
          ),
          staff:profiles(
            id,
            name
          )
        `
        )
        .order('created_at', { ascending: false })
        .limit(100);

      const res = await supabaseQuery<any[]>(() =>
        productId ? base.eq('product_id', productId) : base
      );

      if (!res.ok) {
        logger.error('inventory.log.fetch_failed', { message: res.error.message });
        return res;
      }

      // This reads the stock_movements ledger, so it must be parsed with
      // StockMovementSchema — NOT InventoryLogSchema, whose narrower
      // InventoryAdjustReason enum has no 'refund' and whose productId is
      // non-nullable. Parsing with the wrong schema threw on every refund row,
      // and the throw discarded the entire 100-row batch (silent empty log).
      const logs: StockMovement[] = [];
      for (const row of res.data) {
        const parsed = StockMovementSchema.safeParse({
          id: row.id,
          productId: row.product_id,
          quantityDelta: row.quantity_delta,
          reason: row.reason,
          staffId: row.staff_id,
          createdAt: new Date(row.created_at),
        });
        if (parsed.success) {
          logs.push(parsed.data);
        } else {
          // Skip the offending row only — one unparseable ledger row must never
          // blank the whole Movements tab again.
          logger.warn('inventory.log.row_parse_failed', {
            id: String(row.id),
            reason: String(row.reason),
            issues: parsed.error.issues.map(i => i.path.join('.')).join(','),
          });
        }
      }
      return ok(logs);
    },
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

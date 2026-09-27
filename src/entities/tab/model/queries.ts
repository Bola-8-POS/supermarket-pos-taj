/**
 * TAB ENTITY QUERIES — TanStack Query + Result wrappers (no throws).
 */

import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useCajaStore } from '@entities/caja/model/store';
import { useStaffStore } from '@entities/staff/model/store';
import { isOnline } from '@shared/lib/connectivity';
import {
  ProductSchema,
  type Order,
  type OrderItem,
  type Product,
  type Tab,
} from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  networkOfflineError,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type AppError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Json, Tables } from '@shared/lib/supabase.types';
import { useTabStore } from './store';
import {
  TabSchema,
  OrderSchema,
  OrderItemSchema,
  type CreateTab,
  type CreateOrder,
  type CreateOrderItem,
} from './types';

/* eslint-disable i18next/no-literal-string -- query-key namespace strings +
   unknownError(...) internal debug codes + multi-line Supabase chain args
   below are not UI copy (plugin doesn't resolve excluded callees across a
   multi-line method chain — 21-08 quirk). */
export const tabKeys = {
  all: ['tabs'] as const,
  lists: () => [...tabKeys.all, 'list'] as const,
  list: (filters?: { shiftId?: string; status?: string; cashierScope?: string }) =>
    [...tabKeys.lists(), filters ?? {}] as const,
  details: () => [...tabKeys.all, 'detail'] as const,
  detail: (id: string) => [...tabKeys.details(), id] as const,
};

interface CategoryEmbed {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}

interface ProductRowWithCategory extends Tables<'products'> {
  category?: CategoryEmbed | null;
}

interface OrderItemRow extends Tables<'order_items'> {
  product?: ProductRowWithCategory | null;
}

interface OrderRow extends Tables<'orders'> {
  order_items?: OrderItemRow[] | null;
}

interface TabRow extends Tables<'tabs'> {
  orders?: OrderRow[] | null;
}

function mapProductRow(
  p: ProductRowWithCategory | Tables<'products'> | null | undefined
): Product | undefined {
  if (p == null) return undefined;
  try {
    const catEmbed = 'category' in p ? p.category : null;
    // Pre-type-regen workaround (CLAUDE.md): units_per_package /
    // parent_product_id aren't in supabase.types.ts yet.
    const pRaw = p as unknown as Record<string, unknown>;
    return ProductSchema.parse({
      id: p.id,
      name: p.name,
      categoryId: p.category_id,
      basePrice: p.base_price,
      // legacy HH price column retired (Phase 20, D-01) — superseded by the
      // promotions engine; always null (vestigial nullable field).
      happyHourPrice: null,
      sku: p.sku,
      isActive: p.is_active,
      imageUrl: p.image_url,
      photoPath: (p as { photo_path?: string | null }).photo_path ?? null,
      stock_threshold: p.stock_threshold ?? null,
      // Phase 27: ProductSchema requires these two keys present (nullable,
      // not optional) — omitting them made ANY order item whose product had
      // this field pattern silently drop its `product` (caught, returns
      // undefined) instead of throwing loudly.
      unitsPerPackage: (pRaw['units_per_package'] as number | null | undefined) ?? null,
      parentProductId: (pRaw['parent_product_id'] as string | null | undefined) ?? null,
      // Phase 32: same rationale as unitsPerPackage/parentProductId above —
      // ProductSchema requires these keys present (nullable, not optional).
      brandId: (pRaw['brand_id'] as string | null | undefined) ?? null,
      weightAmount: (pRaw['weight_amount'] as number | null | undefined) ?? null,
      weightUnit: (pRaw['weight_unit'] as string | null | undefined) ?? null,
      modifiers: [],
      ...(catEmbed
        ? {
            category: {
              id: catEmbed.id,
              name: catEmbed.name,
              color: catEmbed.color,
              sortOrder: catEmbed.sort_order,
              // legacy HH start/end columns retired (Phase 20, D-01) — superseded
              // by the promotions engine; always null.
              happyHourStart: null,
              happyHourEnd: null,
              createdAt: new Date(catEmbed.created_at),
            },
          }
        : {}),
    });
  } catch {
    return undefined;
  }
}

function mapOrderItemRow(item: OrderItemRow): Result<OrderItem> {
  try {
    return ok(
      OrderItemSchema.parse({
        id: item.id,
        orderId: item.order_id,
        productId: item.product_id,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        modifierIds: item.modifier_ids,
        modifierPriceDelta: item.modifier_price_delta,
        // Phase 27 (PROMO-06): promotion discount snapshot — read-only,
        // sourced from the stored columns, never re-derived from a live
        // promotion lookup (a reopened/paid tab must show its historical
        // discount even if the promotion was since edited or deleted).
        promotionId: item.promotion_id,
        discountRate: item.discount_rate,
        discountAmount: item.discount_amount,
        notes: item.notes,
        modifiers: [],
        product: mapProductRow(item.product ?? undefined),
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function mapOrderRow(order: OrderRow): Result<Order> {
  try {
    const items: OrderItem[] = [];
    for (const item of order.order_items ?? []) {
      const m = mapOrderItemRow(item);
      if (!m.ok) return m;
      items.push(m.data);
    }
    return ok(
      OrderSchema.parse({
        id: order.id,
        tabId: order.tab_id,
        staffId: order.staff_id,
        createdAt: new Date(order.created_at),
        status: order.status,
        notes: order.notes,
        items,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function mapTabRow(row: TabRow): Result<Tab> {
  try {
    const orders: Order[] = [];
    for (const order of row.orders ?? []) {
      const m = mapOrderRow(order);
      if (!m.ok) return m;
      orders.push(m.data);
    }
    const flatItems = orders.flatMap(o => o.items);
    return ok(
      TabSchema.parse({
        id: row.id,
        customerName: row.customer_name ?? '',
        staffId: row.staff_id,
        shiftId: row.shift_id,
        openedAt: new Date(row.opened_at),
        closedAt: row.closed_at ? new Date(row.closed_at) : null,
        status: row.status,
        notes: row.notes,
        orders,
        items: flatItems,
        ...(row.rappi_order_id != null && row.rappi_order_id !== ''
          ? { rappiOrderId: row.rappi_order_id }
          : {}),
        // Phase 15: optimistic-concurrency version (column added by 20260512000001_versioned_rows)
        ...(typeof (row as { version?: number }).version === 'number'
          ? { version: (row as { version?: number }).version }
          : {}),
        // Phase 23: reopen tracking (columns added by 20260720000003_tabs_reopen_columns)
        ...(typeof row.reopen_count === 'number' ? { reopenCount: row.reopen_count } : {}),
        ...(row.last_reopened_at ? { lastReopenedAt: new Date(row.last_reopened_at) } : {}),
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

const tabListSelect = `
  *,
  orders(
    *,
    order_items(
      *,
      product:products(
        *,
        category:categories(id, name, color, sort_order, created_at)
      )
    )
  )
`;

/** Open tabs for the current shift; syncs {@link useTabStore} on success. */
export function useTabs() {
  const shiftId = useStaffStore(s => s.currentShift?.id);
  const viewerRole = useStaffStore(s => s.currentStaff?.role);
  const viewerStaffId = useStaffStore(s => s.currentStaff?.id);
  const isDisabled = !shiftId;

  const listFilters =
    shiftId != null
      ? viewerRole === 'cashier' && viewerStaffId != null
        ? { shiftId, status: 'open' as const, cashierScope: viewerStaffId }
        : { shiftId, status: 'open' as const }
      : { status: 'open' as const };

  const query = useQuery({
    queryKey: tabKeys.list(listFilters),
    enabled: Boolean(shiftId),
    queryFn: async (): Promise<Result<Tab[]>> => {
      if (!shiftId) {
        return ok([]);
      }

      const res = await supabaseQuery(() =>
        supabase
          .from('tabs')
          .select(tabListSelect)
          .eq('status', 'open')
          .eq('shift_id', shiftId)
          .order('opened_at', { ascending: false })
      );

      if (!res.ok) {
        logger.error('tabs.list.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const tabs: Tab[] = [];
      for (const row of res.data as TabRow[]) {
        const m = mapTabRow(row);
        if (!m.ok) {
          logger.error('tabs.list.map_failed', { message: m.error.message });
          return m;
        }
        tabs.push(m.data);
      }

      const role = useStaffStore.getState().currentStaff?.role;
      const ownId = useStaffStore.getState().currentStaff?.id;
      if (role === 'cashier' && ownId) {
        return ok(tabs.filter(t => t.staffId === ownId));
      }
      return ok(tabs);
    },
  });

  useEffect(() => {
    if (query.data?.ok) {
      useTabStore.getState().loadTabs(query.data.data);
    }
  }, [query.data]);

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
    isDisabled,
  };
}

/** Single tab with nested orders and items. */
export function useTab(id: string) {
  const query = useQuery({
    queryKey: tabKeys.detail(id),
    enabled: Boolean(id),
    queryFn: async (): Promise<Result<Tab>> => {
      const res = await supabaseQuery(() =>
        supabase.from('tabs').select(tabListSelect).eq('id', id).single()
      );

      if (!res.ok) {
        logger.error('tabs.detail.fetch_failed', {
          tabId: id,
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const m = mapTabRow(res.data as unknown as TabRow);
      if (!m.ok) {
        logger.error('tabs.detail.map_failed', { tabId: id, message: m.error.message });
        return m;
      }
      return m;
    },
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.orders.length === 0 && r.data.items.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

type OpenTabMutationContext = {
  previousLists: [QueryKey, unknown][];
  tempId: string;
};

export function useMutationOpenTab() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateTab): Promise<Result<Tab>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }
      const cajaState = useCajaStore.getState();
      if (!cajaState.isCajaOpen || !cajaState.currentCaja) {
        const cajaErr: AppError = {
          code: 'CAJA_CLOSED',
          // eslint-disable-next-line i18next/no-literal-string -- real
          // UI-facing error message, must stay translated despite the
          // file's technical-noise disable above.
          message: i18n.t('entities:tab.cajaNotOpen'),
        };
        return err(cajaErr);
      }
      const cajaSessionId = cajaState.currentCaja.id;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const insertData: any = {
        customer_name: input.customerName,
        staff_id: input.staffId,
        shift_id: input.shiftId,
        status: input.status,
        notes: input.notes,
        caja_session_id: cajaSessionId,
        ...(input.rappiOrderId != null && input.rappiOrderId !== ''
          ? { rappi_order_id: input.rappiOrderId }
          : {}),
      };

      const res = await supabaseMutation(() =>
        supabase.from('tabs').insert(insertData).select().single()
      );

      if (!res.ok) {
        logger.error('tabs.open.insert_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const m = mapTabRow(res.data as unknown as TabRow);
      if (!m.ok) {
        logger.error('tabs.open.map_failed', { message: m.error.message });
        return m;
      }
      return ok(m.data);
    },

    onMutate: async (input): Promise<OpenTabMutationContext> => {
      const tempId = crypto.randomUUID();
      await queryClient.cancelQueries({ queryKey: tabKeys.lists() });
      const previousLists = queryClient.getQueriesData({ queryKey: tabKeys.lists() });

      const optimistic: Tab = TabSchema.parse({
        id: tempId,
        customerName: input.customerName,
        staffId: input.staffId,
        shiftId: input.shiftId,
        openedAt: new Date(),
        closedAt: null,
        status: input.status,
        notes: input.notes,
        orders: [],
        items: [],
        cajaSessionId: useCajaStore.getState().currentCaja?.id ?? null,
        ...(input.rappiOrderId != null && input.rappiOrderId !== ''
          ? { rappiOrderId: input.rappiOrderId }
          : {}),
      });

      useTabStore.getState().openTab(optimistic);

      queryClient.setQueriesData<Result<Tab[]>>({ queryKey: tabKeys.lists() }, old => {
        if (!old || typeof old !== 'object' || !('ok' in old)) return old;
        const o = old;
        if (!o.ok) return old;
        return ok([optimistic, ...o.data]);
      });

      return { previousLists, tempId };
    },

    onSuccess: (result, input, ctx) => {
      const c = ctx as OpenTabMutationContext | undefined;
      if (!result.ok) {
        logger.error('tabs.open.mutation_failed', { message: result.error.message });
        if (result.error.code === 'NETWORK_OFFLINE') {
          // Phase 15 Plan 04: open-tab creates a row — no prior version exists,
          // so capture expectedVersion: 0.
          useTabStore.getState().enqueueOfflineAction({
            type: 'open-tab',
            payload: input,
            expectedVersion: 0,
          });
          // Keep the optimistic tab in place so the UI stays usable offline.
          return;
        }
        if (c?.tempId) {
          useTabStore.setState(s => ({ tabs: s.tabs.filter(t => t.id !== c.tempId) }));
        }
        if (c?.previousLists) {
          for (const [key, data] of c.previousLists) {
            queryClient.setQueryData(key, data);
          }
        }
        return;
      }
      void queryClient.invalidateQueries({ queryKey: tabKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: tabKeys.detail(result.data.id) });
      useTabStore.setState(s => ({
        tabs: [result.data, ...s.tabs.filter(t => t.id !== c?.tempId)],
      }));
    },

    onError: (_e, _input, ctx) => {
      const c = ctx;
      if (c?.tempId) {
        useTabStore.setState(s => ({ tabs: s.tabs.filter(t => t.id !== c.tempId) }));
      }
      if (c?.previousLists) {
        for (const [key, data] of c.previousLists) {
          queryClient.setQueryData(key, data);
        }
      }
    },
  });
}

function buildRpcItemsJson(items: Omit<CreateOrderItem, 'orderId'>[]): {
  product_id: string;
  quantity: number;
  unit_price: number;
  modifier_ids: string[];
  modifier_price_delta: number;
  notes: string | null;
}[] {
  return items.map(item => ({
    product_id: item.productId,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    modifier_ids: item.modifierIds,
    modifier_price_delta: item.modifierPriceDelta,
    notes: item.notes,
  }));
}

type RpcOrderResult = {
  order: Tables<'orders'>;
  items: Tables<'order_items'>[];
};

function mapRpcOrderPayload(data: Json | null): Result<RpcOrderResult> {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return err(unknownError('invalid_rpc_payload'));
    }
    const o = data as { order: Tables<'orders'>; items: Tables<'order_items'>[] };
    if (!Array.isArray(o.items)) {
      return err(unknownError('invalid_rpc_shape'));
    }
    return ok(o);
  } catch (e) {
    return err(unknownError(e));
  }
}

type AddOrderContext = { previousDetail: Result<Tab> | undefined };

export function useMutationAddOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      tabId,
      order,
      items,
    }: {
      tabId: string;
      order: Omit<CreateOrder, 'tabId'>;
      items: Omit<CreateOrderItem, 'orderId'>[];
    }): Promise<Result<{ order: Order; items: OrderItem[] }>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }
      // Phase 15 Group A (D-04 revised): pass p_expected_version when cached
      // tab carries a version. Server-side RPC raises P0V01 (STALE_VERSION) on
      // mismatch; parseSupabaseError maps that to staleVersionError.
      const cachedTab = queryClient.getQueryData<Result<Tab>>(tabKeys.detail(tabId));
      const expectedVersion =
        cachedTab?.ok && typeof cachedTab.data.version === 'number'
          ? cachedTab.data.version
          : undefined;
      const payload = {
        p_tab_id: tabId,
        p_staff_id: order.staffId,
        p_status: order.status,
        p_notes: order.notes ?? '',
        p_items: buildRpcItemsJson(items) as unknown as Json,
        p_skip_depletion: false,
        ...(expectedVersion !== undefined ? { p_expected_version: expectedVersion } : {}),
      };

      const res = await supabaseQuery(() => supabase.rpc('create_order_with_items', payload));

      if (!res.ok) {
        logger.error('tabs.add_order.rpc_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const parsed = mapRpcOrderPayload(res.data as Json);
      if (!parsed.ok) {
        logger.error('tabs.add_order.payload_invalid', { message: parsed.error.message });
        return parsed;
      }

      const { order: orderRow, items: itemRows } = parsed.data;
      const itemsMapped: OrderItem[] = [];
      for (const row of itemRows) {
        const m = mapOrderItemRow(row as OrderItemRow);
        if (!m.ok) return m;
        itemsMapped.push(m.data);
      }
      const orderMapped = OrderSchema.parse({
        id: orderRow.id,
        tabId: orderRow.tab_id,
        staffId: orderRow.staff_id,
        createdAt: new Date(orderRow.created_at),
        status: orderRow.status,
        notes: orderRow.notes,
        items: itemsMapped,
      });
      return ok({ order: orderMapped, items: itemsMapped });
    },

    onMutate: async ({ tabId, order, items }): Promise<AddOrderContext> => {
      await queryClient.cancelQueries({ queryKey: tabKeys.detail(tabId) });
      const previousDetail = queryClient.getQueryData<Result<Tab>>(tabKeys.detail(tabId));
      const tempOrderId = crypto.randomUUID();
      const optimisticItems: OrderItem[] = items.map(it =>
        OrderItemSchema.parse({
          id: crypto.randomUUID(),
          orderId: tempOrderId,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          modifierIds: it.modifierIds,
          modifierPriceDelta: it.modifierPriceDelta,
          notes: it.notes,
          modifiers: [],
        })
      );
      const optimisticOrder = OrderSchema.parse({
        id: tempOrderId,
        tabId,
        staffId: order.staffId,
        createdAt: new Date(),
        status: order.status,
        notes: order.notes,
        items: optimisticItems,
      });

      if (previousDetail?.ok) {
        const t = previousDetail.data;
        const next: Tab = TabSchema.parse({
          ...t,
          orders: [...t.orders, optimisticOrder],
          items: [...t.items, ...optimisticItems],
        });
        queryClient.setQueryData(tabKeys.detail(tabId), ok(next));
      }

      return { previousDetail };
    },

    onSuccess: (result, variables, ctx) => {
      const c = ctx as AddOrderContext | undefined;
      if (!result.ok) {
        if (result.error.code === 'NETWORK_OFFLINE') {
          // Phase 15 Plan 04: capture cached tab.version at enqueue time so the
          // OfflineQueueProcessor can drop the action on STALE_VERSION.
          {
            const cachedTab = queryClient.getQueryData<Result<Tab>>(
              tabKeys.detail(variables.tabId)
            );
            const expectedVersion =
              cachedTab?.ok && typeof cachedTab.data.version === 'number'
                ? cachedTab.data.version
                : 0;
            useTabStore.getState().enqueueOfflineAction({
              type: 'place-order',
              payload: variables,
              expectedVersion,
            });
          }
          // Leave the optimistic order visible — the cache already has it.
          return;
        }
        if (c?.previousDetail !== undefined) {
          queryClient.setQueryData(tabKeys.detail(variables.tabId), c.previousDetail);
        }
        return;
      }
      void queryClient.invalidateQueries({ queryKey: tabKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: tabKeys.detail(variables.tabId) });
    },

    onError: (_e, variables, ctx) => {
      const prev = ctx?.previousDetail;
      if (prev !== undefined) {
        queryClient.setQueryData(tabKeys.detail(variables.tabId), prev);
      }
    },
  });
}

// ============================================================================
// OPEN TABS PENDING TOTAL
// ============================================================================

/**
 * Sums the revenue of all open tabs that belong to the given caja session.
 * Uses order_items joined through orders → tabs to compute the total.
 */
export function useOpenTabsPendingTotal(cajaId: string | null) {
  return useQuery({
    queryKey: ['tabs', 'pending-total', cajaId] as const,
    enabled: cajaId !== null,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Result<number>> => {
      if (!cajaId) return ok(0);

      // Fetch open tabs for the caja session with their order_items
      const { data, error } = await supabase
        .from('tabs')
        .select('id, orders(order_items(quantity, unit_price, modifier_price_delta))')
        .eq('caja_session_id', cajaId)
        .eq('status', 'open');

      if (error) {
        logger.error('tabs.pending_total.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      type PendingOrderItem = {
        quantity: number;
        unit_price: number;
        modifier_price_delta: number;
      };
      type PendingOrder = { order_items: PendingOrderItem[] | null };
      type PendingTabRow = { id: string; orders: PendingOrder[] | null };

      const rows = data as unknown as PendingTabRow[];
      let total = 0;
      for (const tab of rows) {
        for (const order of tab.orders ?? []) {
          for (const item of order.order_items ?? []) {
            total += item.quantity * (item.unit_price + item.modifier_price_delta);
          }
        }
      }

      return ok(Math.round(total * 100) / 100);
    },
  });
}

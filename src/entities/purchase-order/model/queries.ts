/* eslint-disable i18next/no-literal-string */
import type { PostgrestError } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PurchaseOrder,
  PurchaseOrderCreate,
  PurchaseOrderItem,
  PurchaseOrderItemCreate,
} from '@shared/lib/domain';
import { ProductSchema, PurchaseOrderItemSchema, PurchaseOrderSchema, SupplierSchema } from '@shared/lib/domain';
import {
  err,
  notFoundError,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Tables, TablesInsert } from '@shared/lib/supabase.types';

export const purchaseOrderKeys = {
  all: ['purchaseOrders'] as const,
  detail: (id: string) => ['purchaseOrders', id] as const,
};

/** Item list view: a purchase order plus supplier/items summary reduced for display. */
export type PurchaseOrderListItem = PurchaseOrder & {
  supplierName: string;
  itemCount: number;
  totalCost: number;
};

type PurchaseOrderItemRow = Tables<'purchase_order_items'> & {
  product?: Tables<'products'> | null;
};

function mapPO(row: Record<string, unknown>): Result<PurchaseOrder> {
  try {
    return ok(
      PurchaseOrderSchema.parse({
        id: row.id,
        supplierId: row.supplier_id,
        status: row.status,
        createdBy: row.created_by,
        receivedAt: row.received_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function rowPO(input: { supplierId?: string | undefined }): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (input.supplierId !== undefined) value.supplier_id = input.supplierId;
  return value;
}

function mapItem(row: PurchaseOrderItemRow): Result<PurchaseOrderItem> {
  try {
    const product = row.product
      ? ProductSchema.parse({
          id: row.product.id,
          name: row.product.name,
          categoryId: row.product.category_id,
          basePrice: row.product.base_price,
          // legacy HH price column retired (Phase 20, D-01) — always null.
          happyHourPrice: null,
          sku: row.product.sku,
          isActive: row.product.is_active,
          soldByWeight: row.product.sold_by_weight,
          imageUrl: row.product.image_url,
          photoPath: (row.product as { photo_path?: string | null }).photo_path ?? null,
          stock_threshold: row.product.stock_threshold,
          barcode: row.product.barcode,
          unitsPerPackage: row.product.units_per_package,
          parentProductId: row.product.parent_product_id,
          brandId: row.product.brand_id,
          weightAmount: row.product.weight_amount,
          weightUnit: row.product.weight_unit,
          comboEligible: row.product.combo_eligible,
          isCombo: row.product.is_combo,
          comboPriceOverride: row.product.combo_price_override,
          modifiers: [],
        })
      : undefined;
    return ok(
      PurchaseOrderItemSchema.parse({
        id: row.id,
        purchaseOrderId: row.purchase_order_id,
        productId: row.product_id,
        quantity: row.quantity,
        costPrice: row.cost_price,
        product,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function itemInsertRow(
  purchaseOrderId: string,
  item: PurchaseOrderItemCreate
): TablesInsert<'purchase_order_items'> {
  return {
    purchase_order_id: purchaseOrderId,
    product_id: item.productId,
    quantity: item.quantity,
    cost_price: item.costPrice,
  };
}

export function usePurchaseOrders() {
  const query = useQuery({
    queryKey: purchaseOrderKeys.all,
    queryFn: async (): Promise<Result<PurchaseOrderListItem[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('purchase_orders')
          .select('*, supplier:suppliers(name), purchase_order_items(quantity, cost_price)')
          .order('created_at', { ascending: false })
      );
      if (!res.ok) return res;
      const values: PurchaseOrderListItem[] = [];
      for (const item of res.data) {
        const parsed = mapPO(item as Record<string, unknown>);
        if (!parsed.ok) return parsed;
        const raw = item as {
          supplier?: { name: string } | null;
          purchase_order_items?: { quantity: number; cost_price: number }[] | null;
        };
        const lines = raw.purchase_order_items ?? [];
        const totals = lines.reduce(
          (acc, line) => ({
            itemCount: acc.itemCount + 1,
            totalCost: acc.totalCost + line.quantity * line.cost_price,
          }),
          { itemCount: 0, totalCost: 0 }
        );
        values.push({
          ...parsed.data,
          supplierName: raw.supplier?.name ?? '',
          ...totals,
        });
      }
      return ok(values);
    },
    staleTime: 30_000,
  });
  const result = query.data;
  return {
    ...query,
    data: result?.ok ? result.data : undefined,
    resultError: result && !result.ok ? result.error : undefined,
    isEmpty: query.isSuccess && !!result?.ok && result.data.length === 0,
  };
}

export function usePurchaseOrder(id: string | undefined) {
  const query = useQuery({
    queryKey: purchaseOrderKeys.detail(id ?? 'none'),
    enabled: !!id,
    queryFn: async (): Promise<Result<PurchaseOrder>> => {
      if (!id) return err(notFoundError('PurchaseOrder'));
      const res = await supabaseQuery(() =>
        supabase
          .from('purchase_orders')
          .select('*, supplier:suppliers(*), purchase_order_items(*, product:products(*))')
          .eq('id', id)
          .single()
      );
      if (!res.ok) return res;
      const base = mapPO(res.data as unknown as Record<string, unknown>);
      if (!base.ok) return base;

      const raw = res.data as unknown as {
        supplier?: Tables<'suppliers'> | null;
        purchase_order_items?: PurchaseOrderItemRow[] | null;
      };

      const supplier = raw.supplier
        ? SupplierSchema.parse({
            id: raw.supplier.id,
            name: raw.supplier.name,
            contactName: raw.supplier.contact_name,
            phone: raw.supplier.phone,
            email: raw.supplier.email,
            address: raw.supplier.address,
            notes: raw.supplier.notes,
            createdAt: raw.supplier.created_at,
          })
        : undefined;

      const items: PurchaseOrderItem[] = [];
      for (const line of raw.purchase_order_items ?? []) {
        const parsed = mapItem(line);
        if (!parsed.ok) return parsed;
        items.push(parsed.data);
      }

      return ok({ ...base.data, supplier, items });
    },
  });
  const result = query.data;
  return {
    ...query,
    data: result?.ok ? result.data : undefined,
    resultError: result && !result.ok ? result.error : undefined,
  };
}

export function useMutationCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PurchaseOrderCreate): Promise<Result<PurchaseOrder>> => {
      const poRes = await supabaseMutation<Tables<'purchase_orders'>>(() =>
        supabase
          .from('purchase_orders')
          .insert(rowPO({ supplierId: input.supplierId }) as TablesInsert<'purchase_orders'>)
          .select('*')
          .single()
      );
      if (!poRes.ok) return poRes;
      if (poRes.data === null) return err(notFoundError('PurchaseOrder'));
      const po = poRes.data;

      const itemsRes = await supabaseMutation(() =>
        supabase
          .from('purchase_order_items')
          .insert(input.items.map(item => itemInsertRow(po.id, item)))
      );
      if (!itemsRes.ok) return itemsRes;

      return mapPO(po as unknown as Record<string, unknown>);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: purchaseOrderKeys.all }),
  });
}

export function useMutationUpdatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      supplierId: string;
      items: PurchaseOrderItemCreate[];
    }): Promise<Result<null>> => {
      // Runs as a single RPC transaction (update + replace items) so a failed
      // insert can never leave the PO with its items already deleted.
      // Narrow `rpc` cast (not `supabase as any`): update_purchase_order_atomic
      // isn't in supabase.types.ts yet — regen blocked by this environment's
      // docker-in-docker sandbox (CLAUDE.md "Missing generated types workaround").
      // Regenerate and remove this cast ASAP.
      const rpc = supabase.rpc.bind(supabase) as (
        fn: 'update_purchase_order_atomic',
        args: { p_id: string; p_supplier_id: string; p_items: Record<string, unknown>[] }
      ) => PromiseLike<{ data: null; error: PostgrestError | null }>;
      const rpcRes = await supabaseMutation(() =>
        rpc('update_purchase_order_atomic', {
          p_id: input.id,
          p_supplier_id: input.supplierId,
          p_items: input.items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
            costPrice: item.costPrice,
          })),
        })
      );
      return rpcRes.ok ? ok(null) : rpcRes;
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: purchaseOrderKeys.all });
      void qc.invalidateQueries({ queryKey: purchaseOrderKeys.detail(variables.id) });
    },
  });
}

export function useMutationDeletePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Result<null>> => {
      const r = await supabaseMutation(() => supabase.from('purchase_orders').delete().eq('id', id));
      return r.ok ? ok(null) : r;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: purchaseOrderKeys.all }),
  });
}

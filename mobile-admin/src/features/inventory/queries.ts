/**
 * Inventory tab + product-detail queries. Read-only (no writes — see CLAUDE.md hard rules).
 * Every fetch: Supabase query -> throw on error -> Zod parse, same pattern as
 * src/features/today/queries.ts and src/lib/common-queries.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import type { Tone } from '@/components/ui';
import { InventorySchema, ProductSchema, StockMovementSchema, type InventoryRow, type StockMovement } from '@/lib/schemas';
import { supabase } from '@/lib/supabase';

const INVENTORY_WITH_PRODUCT =
  'id,product_id,quantity_on_hand,low_stock_threshold,cost_price,expiry_date,unit, products!inner(id,name,barcode,sku,base_price,is_active,sold_by_weight,category_id,categories(name))';

/** How far below the low-stock threshold a row is; positive = short. */
export const deficit = (row: Pick<InventoryRow, 'quantity_on_hand' | 'low_stock_threshold'>): number =>
  row.low_stock_threshold - row.quantity_on_hand;

/** Pill tone for a days-until-expiry count (already-expired counts as most severe). */
export function expiryTone(daysLeft: number): Tone {
  if (daysLeft < 3) return 'danger';
  return 'warning';
}

/** null when price/cost can't produce a meaningful margin. */
export function marginPct(price: number, cost: number | null): number | null {
  if (cost == null || price <= 0) return null;
  return ((price - cost) / price) * 100;
}

export function useLowStockInventory() {
  return useQuery({
    queryKey: ['inventory', 'low-stock'],
    queryFn: async (): Promise<InventoryRow[]> => {
      const { data, error } = await supabase.from('inventory').select(INVENTORY_WITH_PRODUCT).eq('products.is_active', true);
      if (error) throw new Error(error.message);
      const rows = z.array(InventorySchema).parse(data);
      // Supabase can't compare two columns (quantity_on_hand <= low_stock_threshold) in a
      // single .filter() call, so that check — and the deficit sort — happen client-side.
      return rows.filter(r => r.quantity_on_hand <= r.low_stock_threshold).sort((a, b) => deficit(b) - deficit(a));
    },
  });
}

export function useNearExpiryInventory(days: number) {
  return useQuery({
    queryKey: ['inventory', 'near-expiry', days],
    queryFn: async (): Promise<InventoryRow[]> => {
      const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('inventory')
        .select(INVENTORY_WITH_PRODUCT)
        .eq('products.is_active', true)
        .not('expiry_date', 'is', null)
        .lte('expiry_date', cutoff)
        .gt('quantity_on_hand', 0);
      if (error) throw new Error(error.message);
      const rows = z.array(InventorySchema).parse(data);
      return rows.sort((a, b) => (a.expiry_date ?? '').localeCompare(b.expiry_date ?? ''));
    },
  });
}

const ProductSearchRowSchema = ProductSchema.extend({
  inventory: z
    .array(z.object({ quantity_on_hand: z.number(), expiry_date: z.string().nullable() }))
    .default([]),
});
export type ProductSearchRow = z.infer<typeof ProductSearchRowSchema>;

/** Debounced text, delay in ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(id);
    };
  }, [value, delay]);
  return debounced;
}

export function useProductSearch(query: string) {
  const q = useDebounced(query.trim(), 300);
  return useQuery({
    queryKey: ['inventory', 'search', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<ProductSearchRow[]> => {
      // ilike wildcards/commas in user input would otherwise break the .or() filter syntax.
      const safe = q.replace(/[%,]/g, '');
      const { data, error } = await supabase
        .from('products')
        .select('id,name,barcode,sku,base_price,is_active,sold_by_weight,category_id, categories(name), inventory(quantity_on_hand,expiry_date)')
        .eq('is_active', true)
        .or(`name.ilike.%${safe}%,sku.ilike.%${safe}%,barcode.eq.${safe}`)
        .limit(30);
      if (error) throw new Error(error.message);
      return z.array(ProductSearchRowSchema).parse(data);
    },
  });
}

const ProductDetailSchema = ProductSchema.extend({
  categories: z.object({ name: z.string() }).nullable().optional(),
});
const InventoryBareSchema = InventorySchema.omit({ products: true });

export function useProductDetail(productId: string) {
  return useQuery({
    queryKey: ['inventory', 'product', productId],
    queryFn: async () => {
      const [productRes, invRes] = await Promise.all([
        supabase
          .from('products')
          .select('id,name,barcode,sku,base_price,is_active,sold_by_weight,category_id, categories(name)')
          .eq('id', productId)
          .single(),
        supabase
          .from('inventory')
          .select('id,product_id,quantity_on_hand,low_stock_threshold,cost_price,expiry_date,unit')
          .eq('product_id', productId)
          .maybeSingle(),
      ]);
      if (productRes.error) throw new Error(productRes.error.message);
      if (invRes.error) throw new Error(invRes.error.message);
      return {
        product: ProductDetailSchema.parse(productRes.data),
        inventory: invRes.data ? InventoryBareSchema.parse(invRes.data) : null,
      };
    },
  });
}

export function useProductMovements(productId: string, limit = 20) {
  return useQuery({
    queryKey: ['inventory', 'movements', productId, limit],
    queryFn: async (): Promise<StockMovement[]> => {
      const { data, error } = await supabase
        .from('stock_movements')
        .select('id,product_id,quantity_delta,reason,notes,staff_id,created_at')
        .eq('product_id', productId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(StockMovementSchema).parse(data);
    },
  });
}

/** Human label for a stock_movements.reason value (StockMovementReasonSchema on the desktop). */
const REASON_LABEL: Record<string, string> = {
  sale: 'Sale',
  refund: 'Refund',
  manual_adjustment: 'Adjustment',
  delivery: 'Receive',
  correction: 'Correction',
  physical_count: 'Physical count',
  waste: 'Waste',
  expired: 'Expired',
  void: 'Void',
};

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason.replace(/_/g, ' ');
}

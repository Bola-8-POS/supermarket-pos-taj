/* eslint-disable i18next/no-literal-string */
import { useQuery } from '@tanstack/react-query';
import { computeReorderQuantity } from '@entities/purchase-order/model/reorder-quantity';
import { ok, supabaseQuery, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

/** One suggested reorder line for a chosen supplier's low-stock products. */
export type ReorderSuggestion = {
  productId: string;
  productName: string;
  quantity: number;
  costPrice: number;
};

type InventoryLowStockRow = {
  product_id: string;
  quantity_on_hand: number;
  low_stock_threshold: number;
  cost_price: number | null;
  product: { name: string; units_per_package: number | null } | null;
};

/**
 * Supplier-scoped, low-stock reorder suggestion list (D-07/D-08 applied).
 * RESEARCH.md Pitfall 3: the store-wide lowStockAlerts list is insufficient
 * on its own — must be joined through supplier_products so a "Suggest
 * reorder" click only proposes products this supplier actually carries.
 */
export function useSuggestReorder(supplierId: string | undefined) {
  const query = useQuery({
    queryKey: ['suggestReorder', supplierId ?? 'none'],
    enabled: !!supplierId,
    queryFn: async (): Promise<Result<ReorderSuggestion[]>> => {
      if (!supplierId) return ok([]);

      const idsRes = await supabaseQuery(() =>
        supabase.from('supplier_products').select('product_id').eq('supplier_id', supplierId)
      );
      if (!idsRes.ok) return idsRes;
      const productIds = idsRes.data.map(row => row.product_id);
      if (!productIds.length) return ok([]);

      const res = await supabaseQuery(() =>
        supabase
          .from('inventory')
          .select(
            'product_id, quantity_on_hand, low_stock_threshold, cost_price, product:products(name, units_per_package)'
          )
          .in('product_id', productIds)
          .order('product(name)')
      );
      if (!res.ok) return res;

      const suggestions: ReorderSuggestion[] = [];
      for (const row of res.data as unknown as InventoryLowStockRow[]) {
        if (row.quantity_on_hand > row.low_stock_threshold) continue;
        const quantity = computeReorderQuantity(
          row.quantity_on_hand,
          row.low_stock_threshold,
          row.product?.units_per_package ?? null
        );
        if (quantity === 0) continue;
        suggestions.push({
          productId: row.product_id,
          productName: row.product?.name ?? '',
          quantity,
          costPrice: row.cost_price ?? 0,
        });
      }
      return ok(suggestions);
    },
  });
  const result = query.data;
  return {
    ...query,
    data: result?.ok ? result.data : undefined,
    resultError: result && !result.ok ? result.error : undefined,
  };
}

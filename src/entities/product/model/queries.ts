import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { syncProductSuppliers } from '@entities/supplier';
import type {
  Category,
  Modifier,
  ModifierCreate,
  ModifierUpdate,
  Product,
  ProductCreate,
  ProductUpdate,
} from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
/* eslint-disable i18next/no-literal-string -- query-key namespace strings
   below are not UI copy; unknownError(...) codes are internal debug
   metadata, not the user-visible AppError.message. */
import {
  err,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Tables, TablesInsert, TablesUpdate } from '@shared/lib/supabase.types';
import { useProductStore } from './store';
import { ProductSchema, CategorySchema, ModifierSchema } from './types';

type ProductModifierJoin = {
  modifier: Tables<'modifiers'> | null;
};

export type ProductRow = Tables<'products'> & {
  category: Tables<'categories'> | null;
  product_modifiers: ProductModifierJoin[] | null;
};

export function mapProductRow(row: ProductRow): Result<Product> {
  try {
    const modifiers = (row.product_modifiers ?? [])
      .map(pm => pm.modifier)
      .filter((m): m is Tables<'modifiers'> => Boolean(m))
      .map(m =>
        ModifierSchema.parse({
          id: m.id,
          name: m.name,
          priceDelta: m.price_delta,
          sortOrder: m.sort_order,
        })
      );

    const category =
      row.category != null
        ? CategorySchema.parse({
            id: row.category.id,
            name: row.category.name,
            color: row.category.color,
            sortOrder: row.category.sort_order,
            // legacy HH start/end columns retired (Phase 20, D-01) — superseded by
            // the promotions engine; always null (vestigial nullable field).
            happyHourStart: null,
            happyHourEnd: null,
            createdAt: new Date(row.category.created_at),
          })
        : undefined;

    return ok(
      ProductSchema.parse({
        id: row.id,
        name: row.name,
        categoryId: row.category_id,
        basePrice: row.base_price,
        // legacy HH price column retired (Phase 20, D-01) — superseded by the
        // promotions engine; always null (vestigial nullable field).
        happyHourPrice: null,
        sku: row.sku,
        isActive: row.is_active,
        soldByWeight: row.sold_by_weight,
        comboEligible: row.combo_eligible,
        imageUrl: row.image_url,
        photoPath: row.photo_path ?? null,
        stock_threshold: row.stock_threshold ?? null,
        barcode: (row as { barcode?: string | null }).barcode ?? null,
        unitsPerPackage: (row as { units_per_package?: number | null }).units_per_package ?? null,
        parentProductId: (row as { parent_product_id?: string | null }).parent_product_id ?? null,
        brandId: (row as { brand_id?: string | null }).brand_id ?? null,
        weightAmount: (row as { weight_amount?: number | null }).weight_amount ?? null,
        weightUnit: (row as { weight_unit?: string | null }).weight_unit ?? null,
        quantityOnHand:
          (row as { inventory?: { quantity_on_hand: number } | null }).inventory
            ?.quantity_on_hand ?? undefined,
        lowStockThreshold:
          (row as { inventory?: { low_stock_threshold: number } | null }).inventory
            ?.low_stock_threshold ?? undefined,
        modifiers,
        category,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function mapCategoryRow(row: Tables<'categories'>): Result<Category> {
  try {
    return ok(
      CategorySchema.parse({
        id: row.id,
        name: row.name,
        color: row.color,
        sortOrder: row.sort_order,
        // legacy HH start/end columns retired (Phase 20, D-01) — superseded by the
        // promotions engine; always null (vestigial nullable Zod field).
        happyHourStart: null,
        happyHourEnd: null,
        createdAt: new Date(row.created_at),
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function mapModifierRow(row: Tables<'modifiers'>): Result<Modifier> {
  try {
    return ok(
      ModifierSchema.parse({
        id: row.id,
        name: row.name,
        priceDelta: row.price_delta,
        sortOrder: row.sort_order,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

/**
 * Fetches all active products with their category and modifiers.
 * On success updates {@link useProductStore}; returns `Result` (never throws).
 */
export function useProducts() {
  const setProducts = useProductStore(state => state.setProducts);

  const query = useQuery({
    queryKey: ['products'],
    queryFn: async (): Promise<Result<Product[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('products')
          .select(
            `
            *,
            category:categories(*),
            product_modifiers(
              modifier:modifiers(*)
            ),
            inventory(quantity_on_hand, low_stock_threshold)
          `
          )
          .eq('is_active', true)
          .order('name')
      );

      if (!res.ok) {
        logger.error('products.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const products: Product[] = [];
      for (const row of res.data as ProductRow[]) {
        const mapped = mapProductRow(row);
        if (!mapped.ok) {
          logger.error('products.map_failed', { message: mapped.error.message });
          return mapped;
        }
        products.push(mapped.data);
      }
      return ok(products);
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (query.data?.ok) setProducts(query.data.data);
  }, [query.data, setProducts]);

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
 * Fetches all categories sorted by sort_order.
 * On success updates {@link useProductStore}; returns `Result` (never throws).
 */
export function useCategories() {
  const setCategories = useProductStore(state => state.setCategories);

  const query = useQuery({
    queryKey: ['categories'],
    queryFn: async (): Promise<Result<Category[]>> => {
      const res = await supabaseQuery(() =>
        supabase.from('categories').select('*').order('sort_order')
      );

      if (!res.ok) {
        logger.error('categories.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const categories: Category[] = [];
      for (const row of res.data) {
        const mapped = mapCategoryRow(row);
        if (!mapped.ok) {
          logger.error('categories.map_failed', { message: mapped.error.message });
          return mapped;
        }
        categories.push(mapped.data);
      }
      return ok(categories);
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (query.data?.ok) setCategories(query.data.data);
  }, [query.data, setCategories]);

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
 * Fetches all modifiers sorted by sort_order.
 * On success updates {@link useProductStore}; returns `Result` (never throws).
 */
export function useModifiers() {
  const setModifiers = useProductStore(state => state.setModifiers);

  const query = useQuery({
    queryKey: ['modifiers'],
    queryFn: async (): Promise<Result<Modifier[]>> => {
      const res = await supabaseQuery(() =>
        supabase.from('modifiers').select('*').order('sort_order')
      );

      if (!res.ok) {
        logger.error('modifiers.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const modifiers: Modifier[] = [];
      for (const row of res.data) {
        const mapped = mapModifierRow(row);
        if (!mapped.ok) {
          logger.error('modifiers.map_failed', { message: mapped.error.message });
          return mapped;
        }
        modifiers.push(mapped.data);
      }
      return ok(modifiers);
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (query.data?.ok) setModifiers(query.data.data);
  }, [query.data, setModifiers]);

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

const PRODUCT_MANAGEMENT_QUERY_KEY = ['products', 'management'] as const;

/**
 * Fetches all products (active and inactive) for catalog management UI.
 * Does not update {@link useProductStore} — POS continues to use {@link useProducts} only.
 */
export function useProductsForManagement() {
  const query = useQuery({
    queryKey: PRODUCT_MANAGEMENT_QUERY_KEY,
    queryFn: async (): Promise<Result<Product[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('products')
          .select(
            `
            *,
            category:categories(*),
            product_modifiers(
              modifier:modifiers(*)
            ),
            inventory(quantity_on_hand, low_stock_threshold)
          `
          )
          .order('name')
      );

      if (!res.ok) {
        logger.error('products.management.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const products: Product[] = [];
      for (const row of res.data as ProductRow[]) {
        const mapped = mapProductRow(row);
        if (!mapped.ok) {
          logger.error('products.management.map_failed', { message: mapped.error.message });
          return mapped;
        }
        products.push(mapped.data);
      }
      return ok(products);
    },
    staleTime: 60 * 1000,
  });

  const rm = query.data;
  return {
    ...query,
    data: rm?.ok ? rm.data : undefined,
    resultError: rm && !rm.ok ? rm.error : undefined,
    isEmpty: query.isSuccess && !!rm?.ok && rm.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export function invalidateCatalogQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: PRODUCT_MANAGEMENT_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ['categories'] });
  void queryClient.invalidateQueries({ queryKey: ['modifiers'] });
}

async function syncProductModifiers(
  productId: string,
  modifierIds: readonly string[]
): Promise<Result<null>> {
  const delRes = await supabaseMutation(() =>
    supabase.from('product_modifiers').delete().eq('product_id', productId)
  );
  if (!delRes.ok) return delRes;

  if (modifierIds.length === 0) return ok(null);

  const rows: TablesInsert<'product_modifiers'>[] = modifierIds.map(modifierId => ({
    product_id: productId,
    modifier_id: modifierId,
  }));

  const insRes = await supabaseMutation(() => supabase.from('product_modifiers').insert(rows));
  if (!insRes.ok) {
    logger.error('product_modifiers.insert_failed', { message: insRes.error.message });
    return insRes;
  }
  return ok(null);
}

export function productUpdateToRow(
  patch: Partial<Omit<ProductUpdate, 'id'>>
): TablesUpdate<'products'> {
  const row: TablesUpdate<'products'> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (patch.basePrice !== undefined) row.base_price = patch.basePrice;
  if (patch.comboEligible !== undefined) row.combo_eligible = patch.comboEligible;
  // Legacy HH price column no longer written (Phase 20, D-01) — happy-hour pricing
  // is now managed in Settings → Promotions.
  if (patch.sku !== undefined) row.sku = patch.sku;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  if (patch.imageUrl !== undefined) row.image_url = patch.imageUrl;
  if (patch.photoPath !== undefined) row.photo_path = patch.photoPath;
  if (patch.barcode !== undefined) {
    (row as Record<string, unknown>).barcode = patch.barcode;
  }
  if (patch.unitsPerPackage !== undefined) {
    (row as Record<string, unknown>).units_per_package = patch.unitsPerPackage;
  }
  if (patch.parentProductId !== undefined) {
    (row as Record<string, unknown>).parent_product_id = patch.parentProductId;
  }
  if (patch.brandId !== undefined) {
    (row as Record<string, unknown>).brand_id = patch.brandId;
  }
  if (patch.weightAmount !== undefined) {
    (row as Record<string, unknown>).weight_amount = patch.weightAmount;
  }
  if (patch.weightUnit !== undefined) {
    (row as Record<string, unknown>).weight_unit = patch.weightUnit;
  }
  return row;
}

export type CreateProductInput = ProductCreate & {
  modifierIds: readonly string[];
  supplierIds?: readonly string[];
};

export type UpdateProductInput = ProductUpdate & {
  modifierIds?: readonly string[];
  supplierIds?: readonly string[];
};

export function useMutationCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProductInput): Promise<Result<Product>> => {
      const { modifierIds, supplierIds, ...product } = input;
      // Legacy HH price column no longer written (Phase 20, D-01) — happy-hour
      // pricing is now managed in Settings → Promotions.
      const insertRow: TablesInsert<'products'> = {
        name: product.name,
        category_id: product.categoryId,
        base_price: product.basePrice,
        sku: product.sku,
        is_active: product.isActive,
        image_url: product.imageUrl,
        combo_eligible: product.comboEligible,
      };
      if (product.barcode !== undefined && product.barcode !== null) {
        (insertRow as Record<string, unknown>).barcode = product.barcode;
      }
      (insertRow as Record<string, unknown>).units_per_package = product.unitsPerPackage;
      (insertRow as Record<string, unknown>).parent_product_id = product.parentProductId;
      (insertRow as Record<string, unknown>).brand_id = product.brandId;
      (insertRow as Record<string, unknown>).weight_amount = product.weightAmount;
      (insertRow as Record<string, unknown>).weight_unit = product.weightUnit;

      const res = await supabaseMutation<Tables<'products'>>(() =>
        supabase.from('products').insert(insertRow).select('*').single()
      );

      if (!res.ok) {
        logger.error('products.create_failed', { message: res.error.message });
        return res;
      }
      const inserted = res.data;
      if (inserted == null) {
        return err(unknownError('no_row'));
      }

      const productId = inserted.id;
      const linkRes = await syncProductModifiers(productId, modifierIds);
      if (!linkRes.ok) return linkRes;
      if (supplierIds) {
        const supplierRes = await syncProductSuppliers(productId, supplierIds);
        if (!supplierRes.ok) return supplierRes;
      }

      const full = await supabaseQuery(() =>
        supabase
          .from('products')
          .select(
            `
            *,
            category:categories(*),
            product_modifiers(
              modifier:modifiers(*)
            ),
            inventory(quantity_on_hand, low_stock_threshold)
          `
          )
          .eq('id', productId)
          .single()
      );

      if (!full.ok) return full;
      return mapProductRow(full.data as unknown as ProductRow);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export function useMutationUpdateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateProductInput): Promise<Result<null>> => {
      const { id, modifierIds, supplierIds, ...patch } = input;
      const row = productUpdateToRow(patch);
      if (Object.keys(row).length > 0) {
        const upd = await supabaseMutation(() =>
          supabase.from('products').update(row).eq('id', id).select('id').single()
        );
        if (!upd.ok) {
          logger.error('products.update_failed', { message: upd.error.message });
          return upd;
        }
      }

      if (modifierIds !== undefined) {
        const linkRes = await syncProductModifiers(id, modifierIds);
        if (!linkRes.ok) return linkRes;
      }
      if (supplierIds !== undefined) {
        const supplierRes = await syncProductSuppliers(id, supplierIds);
        if (!supplierRes.ok) return supplierRes;
      }

      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export function useMutationDeactivateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (productId: string): Promise<Result<null>> => {
      const res = await supabaseMutation(() =>
        supabase.from('products').update({ is_active: false }).eq('id', productId)
      );
      if (!res.ok) {
        logger.error('products.deactivate_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export function useMutationCreateModifier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ModifierCreate): Promise<Result<Modifier>> => {
      const insertRow: TablesInsert<'modifiers'> = {
        name: input.name,
        price_delta: input.priceDelta,
        sort_order: input.sortOrder,
      };
      const res = await supabaseMutation(() =>
        supabase.from('modifiers').insert(insertRow).select('*').single()
      );
      if (!res.ok) {
        logger.error('modifiers.create_failed', { message: res.error.message });
        return res;
      }
      return mapModifierRow(res.data as unknown as Tables<'modifiers'>);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export function useMutationUpdateModifier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ModifierUpdate): Promise<Result<null>> => {
      const { id, ...rest } = input;
      const row: TablesUpdate<'modifiers'> = {};
      if (rest.name !== undefined) row.name = rest.name;
      if (rest.priceDelta !== undefined) row.price_delta = rest.priceDelta;
      if (rest.sortOrder !== undefined) row.sort_order = rest.sortOrder;
      if (Object.keys(row).length === 0) return ok(null);

      const res = await supabaseMutation(() => supabase.from('modifiers').update(row).eq('id', id));
      if (!res.ok) {
        logger.error('modifiers.update_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export function useMutationDeleteModifier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (modifierId: string): Promise<Result<null>> => {
      const res = await supabaseMutation(() =>
        supabase.from('modifiers').delete().eq('id', modifierId)
      );
      if (!res.ok) {
        logger.error('modifiers.delete_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

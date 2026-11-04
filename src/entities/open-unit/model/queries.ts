/* eslint-disable */
// TODO(27-05): Remove this eslint-disable and the `db` cast below once
// `open_units` and `products.units_per_package`/`products.parent_product_id`
// appear in supabase.types.ts — regenerate with:
//   npx supabase gen types typescript --local > src/shared/lib/supabase.types.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpenUnit, OpenUnitCorrection, Product } from '@shared/lib/domain';
import { CategorySchema, OpenUnitCorrectionSchema, OpenUnitSchema, ProductSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type AppError, type Result, unknownError } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

// Pre-type-regen workaround (CLAUDE.md): `open_units` and the two new
// `products` columns are not in supabase.types.ts yet.
const db = supabase as any;

export const openUnitKeys = {
  all: ['open_units'] as const,
  lists: () => [...openUnitKeys.all, 'list'] as const,
  active: () => [...openUnitKeys.all, 'active'] as const,
};

/**
 * Maps an RPC's raw exception message to a typed AppError, preserving the
 * RPC's own message verbatim — D-08's interpolated remaining count (and every
 * other RPC-authored message) must survive to the UI untouched.
 */
function mapRpcError(message: string): AppError {
  if (message.startsWith('DUPLICATE_ENTRY')) {
    return { code: 'DUPLICATE_ENTRY', message };
  }
  if (message.startsWith('AUTH_FORBIDDEN')) {
    return { code: 'AUTH_FORBIDDEN', message };
  }
  if (message.startsWith('INVENTORY_NEGATIVE')) {
    return { code: 'INVENTORY_NEGATIVE', message };
  }
  if (message.startsWith('VALIDATION_ERROR')) {
    return { code: 'VALIDATION_ERROR', message };
  }
  if (message.startsWith('NOT_FOUND')) {
    return { code: 'NOT_FOUND', message };
  }
  return { code: 'SUPABASE_ERROR', message };
}

function mapOpenUnitRow(row: Record<string, unknown>): Result<OpenUnit> {
  try {
    let product: Product | undefined;
    const productRow = row['product'] as Record<string, unknown> | null | undefined;
    if (productRow) {
      const categoryRow = productRow['category'] as Record<string, unknown> | null | undefined;
      const category = categoryRow
        ? CategorySchema.parse({
            id: categoryRow['id'],
            name: categoryRow['name'],
            color: categoryRow['color'],
            sortOrder: categoryRow['sort_order'],
            // legacy HH start/end columns retired (Phase 20, D-01) — always null.
            happyHourStart: null,
            happyHourEnd: null,
            createdAt: new Date(categoryRow['created_at'] as string),
          })
        : undefined;

      product = ProductSchema.parse({
        id: productRow['id'],
        name: productRow['name'],
        categoryId: productRow['category_id'],
        basePrice: productRow['base_price'],
        // legacy HH price column retired (Phase 20, D-01) — always null.
        happyHourPrice: null,
        sku: productRow['sku'],
        isActive: productRow['is_active'],
        imageUrl: productRow['image_url'],
        photoPath: (productRow['photo_path'] as string | null | undefined) ?? null,
        stock_threshold: productRow['stock_threshold'] ?? null,
        unitsPerPackage: productRow['units_per_package'] ?? null,
        parentProductId: productRow['parent_product_id'] ?? null,
        brandId: productRow['brand_id'] ?? null,
        weightAmount: productRow['weight_amount'] ?? null,
        weightUnit: productRow['weight_unit'] ?? null,
        modifiers: [],
        category,
      });
    }

    return ok(
      OpenUnitSchema.parse({
        id: row['id'],
        productId: row['product_id'],
        remainingCount: row['remaining_count'],
        status: row['status'],
        openedBy: row['opened_by'] ?? null,
        openedAt: new Date(row['opened_at'] as string),
        closedBy: row['closed_by'] ?? null,
        closedAt: row['closed_at'] ? new Date(row['closed_at'] as string) : null,
        closedReason: row['closed_reason'] ?? null,
        createdAt: new Date(row['created_at'] as string),
        updatedAt: new Date(row['updated_at'] as string),
        product,
      })
    );
  } catch (e) {
    logger.error('open_unit.map_failed', { message: e instanceof Error ? e.message : String(e) });
    return err(unknownError(e));
  }
}

export function useOpenUnits(opts?: { activeOnly?: boolean }) {
  const activeOnly = opts?.activeOnly ?? false;

  const query = useQuery({
    queryKey: activeOnly ? openUnitKeys.active() : openUnitKeys.lists(),
    queryFn: async (): Promise<Result<OpenUnit[]>> => {
      let builder = db
        .from('open_units')
        .select('*, product:products(*, category:categories(*))')
        .order('opened_at', { ascending: false });

      if (activeOnly) {
        builder = builder.eq('status', 'active');
      }

      const { data, error } = await builder;

      if (error) {
        logger.error('open_unit.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      const list: OpenUnit[] = [];
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const m = mapOpenUnitRow(row);
        if (!m.ok) return m;
        list.push(m.data);
      }
      return ok(list);
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

function invalidateOpenUnits(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: openUnitKeys.all });
}

export function useMutationOpenOpenUnit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (productId: string): Promise<Result<string>> => {
      const { data, error } = await db.rpc('open_open_unit', { p_product_id: productId });

      if (error) {
        const message: string = (error as { message?: string }).message ?? '';
        logger.error('open_unit.open_failed', { message });
        return err(mapRpcError(message));
      }

      return ok(data as string);
    },
    onSuccess: result => {
      if (!result.ok) return;
      invalidateOpenUnits(queryClient);
    },
  });
}

export function useMutationCorrectOpenUnit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: OpenUnitCorrection): Promise<Result<void>> => {
      const parsed = OpenUnitCorrectionSchema.safeParse(input);
      if (!parsed.success) {
        return err({ code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid correction input' });
      }

      const { error } = await db.rpc('correct_open_unit', {
        p_open_unit_id: parsed.data.openUnitId,
        p_remaining_count: parsed.data.remainingCount,
        p_reason: parsed.data.reason,
      });

      if (error) {
        const message: string = (error as { message?: string }).message ?? '';
        logger.error('open_unit.correct_failed', { message });
        return err(mapRpcError(message));
      }

      return ok(undefined);
    },
    onSuccess: result => {
      if (!result.ok) return;
      invalidateOpenUnits(queryClient);
    },
  });
}

export function useMutationVoidOpenUnit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      openUnitId,
      reason,
    }: {
      openUnitId: string;
      reason: string;
    }): Promise<Result<void>> => {
      const trimmedReason = reason.trim();
      if (trimmedReason.length === 0) {
        return err({ code: 'VALIDATION_ERROR', message: 'Reason is required' });
      }

      const { error } = await db.rpc('void_open_unit', {
        p_open_unit_id: openUnitId,
        p_reason: trimmedReason,
      });

      if (error) {
        const message: string = (error as { message?: string }).message ?? '';
        logger.error('open_unit.void_failed', { message });
        return err(mapRpcError(message));
      }

      return ok(undefined);
    },
    onSuccess: result => {
      if (!result.ok) return;
      invalidateOpenUnits(queryClient);
    },
  });
}

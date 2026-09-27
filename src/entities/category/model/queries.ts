import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Category, CategoryCreate, CategoryRouting, CategoryUpdate } from '@shared/lib/domain';
import { CategorySchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
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

// ============================================================================
// QUERY KEYS
// ============================================================================
/* eslint-disable i18next/no-literal-string -- TanStack Query cache-key
   namespace strings below are not UI copy. */

const CATEGORY_QUERY_KEY = ['categories'] as const;

// ============================================================================
// ROW MAPPER
// ============================================================================

function mapCategoryRow(row: Tables<'categories'>): Result<Category> {
  try {
    return ok(
      CategorySchema.parse({
        id: row.id,
        name: row.name,
        color: row.color,
        sortOrder: row.sort_order,
        // Legacy HH start/end columns retired (Phase 20, D-01) — superseded
        // by the promotions engine; always null (vestigial nullable field).
        happyHourStart: null,
        happyHourEnd: null,
        routing: (row as { routing?: CategoryRouting }).routing ?? 'NONE',
        parentId: (row as { parent_id?: string | null }).parent_id ?? null,
        comboEligible: row.combo_eligible,
        createdAt: new Date(row.created_at),
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function invalidateCategoryQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: CATEGORY_QUERY_KEY });
  // Also invalidate products so embedded category joins refresh
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: ['products', 'management'] });
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Fetches all categories sorted by sort_order.
 * Shares the `['categories']` TanStack Query key with the product entity hook,
 * so fetches are deduplicated when both are mounted simultaneously.
 */
export function useCategories() {
  const query = useQuery({
    queryKey: CATEGORY_QUERY_KEY,
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

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

// ============================================================================
// MUTATIONS
// ============================================================================

export function useMutationCreateCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CategoryCreate): Promise<Result<Category>> => {
      // Legacy HH start/end columns no longer written (Phase 20, D-01) —
      // happy-hour pricing is now managed in Settings → Promotions.
      const insertRow: TablesInsert<'categories'> = {
        name: input.name,
        color: input.color,
        sort_order: input.sortOrder,
        routing: input.routing,
        parent_id: input.parentId ?? null,
        combo_eligible: input.comboEligible,
      };

      const res = await supabaseMutation(() =>
        supabase.from('categories').insert(insertRow).select('*').single()
      );

      if (!res.ok) {
        logger.error('categories.create_failed', { message: res.error.message });
        return res;
      }
      return mapCategoryRow(res.data as unknown as Tables<'categories'>);
    },
    onSuccess: result => {
      if (result.ok) invalidateCategoryQueries(queryClient);
    },
  });
}

export function useMutationUpdateCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CategoryUpdate): Promise<Result<null>> => {
      const { id, ...rest } = input;
      const row: TablesUpdate<'categories'> = {};
      if (rest.name !== undefined) row.name = rest.name;
      if (rest.color !== undefined) row.color = rest.color;
      if (rest.sortOrder !== undefined) row.sort_order = rest.sortOrder;
      // Legacy HH start/end columns no longer written (Phase 20, D-01) —
      // happy-hour pricing is now managed in Settings → Promotions.
      if (rest.routing !== undefined) row.routing = rest.routing;
      if (rest.parentId !== undefined) row.parent_id = rest.parentId;
      if (rest.comboEligible !== undefined) row.combo_eligible = rest.comboEligible;

      if (Object.keys(row).length === 0) return ok(null);

      const res = await supabaseMutation(() =>
        supabase.from('categories').update(row).eq('id', id)
      );
      if (!res.ok) {
        logger.error('categories.update_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateCategoryQueries(queryClient);
    },
  });
}

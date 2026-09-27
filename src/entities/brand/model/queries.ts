import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Brand, BrandCreate, BrandUpdate } from '@shared/lib/domain';
import { BrandSchema } from '@shared/lib/domain';
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

const BRAND_QUERY_KEY = ['brands'] as const;

// ============================================================================
// ROW MAPPER
// ============================================================================

function mapBrandRow(row: Tables<'brands'>): Result<Brand> {
  try {
    return ok(
      BrandSchema.parse({
        id: row.id,
        name: row.name,
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

function invalidateBrandQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: BRAND_QUERY_KEY });
  // Brand is a product join/filter field — invalidate products too.
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: ['products', 'management'] });
}

// ============================================================================
// QUERIES
// ============================================================================

/** Fetches all brands sorted alphabetically by name (D-01: no sortOrder field). */
export function useBrands() {
  const query = useQuery({
    queryKey: BRAND_QUERY_KEY,
    queryFn: async (): Promise<Result<Brand[]>> => {
      const res = await supabaseQuery(() => supabase.from('brands').select('*').order('name'));

      if (!res.ok) {
        logger.error('brands.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const brands: Brand[] = [];
      for (const row of res.data) {
        const mapped = mapBrandRow(row);
        if (!mapped.ok) {
          logger.error('brands.map_failed', { message: mapped.error.message });
          return mapped;
        }
        brands.push(mapped.data);
      }
      return ok(brands);
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

export function useMutationCreateBrand() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: BrandCreate): Promise<Result<Brand>> => {
      const insertRow: TablesInsert<'brands'> = { name: input.name };

      const res = await supabaseMutation(() =>
        supabase.from('brands').insert(insertRow).select('*').single()
      );

      if (!res.ok) {
        logger.error('brands.create_failed', { message: res.error.message });
        return res;
      }
      return mapBrandRow(res.data as unknown as Tables<'brands'>);
    },
    onSuccess: result => {
      if (result.ok) invalidateBrandQueries(queryClient);
    },
  });
}

export function useMutationUpdateBrand() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: BrandUpdate): Promise<Result<null>> => {
      const { id, ...rest } = input;
      const row: TablesUpdate<'brands'> = {};
      if (rest.name !== undefined) row.name = rest.name;

      if (Object.keys(row).length === 0) return ok(null);

      const res = await supabaseMutation(() => supabase.from('brands').update(row).eq('id', id));
      if (!res.ok) {
        logger.error('brands.update_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateBrandQueries(queryClient);
    },
  });
}

export function useMutationDeleteBrand() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (brandId: string): Promise<Result<null>> => {
      const res = await supabaseMutation(() => supabase.from('brands').delete().eq('id', brandId));
      if (!res.ok) {
        logger.error('brands.delete_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidateBrandQueries(queryClient);
    },
  });
}

/* eslint-disable i18next/no-literal-string */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Supplier, SupplierCreate, SupplierUpdate } from '@shared/lib/domain';
import { SupplierSchema } from '@shared/lib/domain';
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
import type { Tables, TablesInsert, TablesUpdate } from '@shared/lib/supabase.types';

export const supplierKeys = {
  all: ['suppliers'] as const,
  detail: (id: string) => ['suppliers', id] as const,
  products: (id: string) => ['suppliers', id, 'products'] as const,
};
function map(row: Record<string, unknown>): Result<Supplier> {
  try {
    return ok(
      SupplierSchema.parse({
        id: row.id,
        name: row.name,
        contactName: row.contact_name,
        phone: row.phone,
        email: row.email,
        address: row.address,
        notes: row.notes,
        createdAt: row.created_at,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}
function row(input: {
  name?: string | undefined;
  contactName?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
  notes?: string | null | undefined;
}) {
  const value: Record<string, unknown> = {};
  if (input.name !== undefined) value.name = input.name;
  if (input.contactName !== undefined) value.contact_name = input.contactName;
  if (input.phone !== undefined) value.phone = input.phone;
  if (input.email !== undefined) value.email = input.email;
  if (input.address !== undefined) value.address = input.address;
  if (input.notes !== undefined) value.notes = input.notes;
  return value;
}
export function useSuppliers() {
  const query = useQuery({
    queryKey: supplierKeys.all,
    queryFn: async (): Promise<Result<Supplier[]>> => {
      const res = await supabaseQuery(() => supabase.from('suppliers').select('*').order('name'));
      if (!res.ok) return res;
      const values: Supplier[] = [];
      for (const item of res.data) {
        const parsed = map(item);
        if (!parsed.ok) return parsed;
        values.push(parsed.data);
      }
      return ok(values);
    },
    staleTime: 60_000,
  });
  const result = query.data;
  return {
    ...query,
    data: result?.ok ? result.data : undefined,
    resultError: result && !result.ok ? result.error : undefined,
    isEmpty: query.isSuccess && !!result?.ok && result.data.length === 0,
  };
}
export function useSupplierProductIds(supplierId?: string) {
  const q = useQuery({
    queryKey: supplierKeys.products(supplierId ?? 'none'),
    enabled: !!supplierId,
    queryFn: async (): Promise<Result<string[]>> => {
      if (!supplierId) return ok([]);
      const r = await supabaseQuery(() =>
        supabase.from('supplier_products').select('product_id').eq('supplier_id', supplierId)
      );
      return r.ok ? ok(r.data.map(x => x.product_id)) : r;
    },
  });
  return { ...q, data: q.data?.ok ? q.data.data : undefined };
}
export function useProductSupplierIds(productId?: string) {
  const q = useQuery({
    queryKey: ['products', productId, 'suppliers'],
    enabled: !!productId,
    queryFn: async (): Promise<Result<string[]>> => {
      if (!productId) return ok([]);
      const r = await supabaseQuery(() =>
        supabase.from('supplier_products').select('supplier_id').eq('product_id', productId)
      );
      return r.ok ? ok(r.data.map(x => x.supplier_id)) : r;
    },
  });
  return { ...q, data: q.data?.ok ? q.data.data : undefined };
}
export async function syncSupplierProducts(
  supplierId: string,
  productIds: readonly string[]
): Promise<Result<null>> {
  const del = await supabaseMutation(() =>
    supabase.from('supplier_products').delete().eq('supplier_id', supplierId)
  );
  if (!del.ok) return del;
  return productIds.length
    ? supabaseMutation(() =>
        supabase
          .from('supplier_products')
          .insert(productIds.map(product_id => ({ supplier_id: supplierId, product_id })))
      )
    : ok(null);
}

export async function syncProductSuppliers(
  productId: string,
  supplierIds: readonly string[]
): Promise<Result<null>> {
  const del = await supabaseMutation(() =>
    supabase.from('supplier_products').delete().eq('product_id', productId)
  );
  if (!del.ok) return del;
  return supplierIds.length
    ? supabaseMutation(() =>
        supabase
          .from('supplier_products')
          .insert(supplierIds.map(supplier_id => ({ supplier_id, product_id: productId })))
      )
    : ok(null);
}
export function useMutationCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: SupplierCreate & { productIds?: readonly string[] }
    ): Promise<Result<Supplier>> => {
      const { productIds, ...fields } = input;
      const r = await supabaseMutation<Tables<'suppliers'>>(() =>
        supabase
          .from('suppliers')
          .insert(row(fields) as TablesInsert<'suppliers'>)
          .select('*')
          .single()
      );
      if (!r.ok) return r;
      if (r.data === null) return err(notFoundError('Supplier'));
      if (productIds) {
        const linked = await syncSupplierProducts(r.data.id, productIds);
        if (!linked.ok) return linked;
      }
      return map(r.data);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: supplierKeys.all }),
  });
}
export function useMutationUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: SupplierUpdate & { productIds?: readonly string[] }
    ): Promise<Result<null>> => {
      const { id, productIds, ...fields } = input;
      const r = await supabaseMutation(() =>
        supabase
          .from('suppliers')
          .update(row(fields) as TablesUpdate<'suppliers'>)
          .eq('id', id)
      );
      if (!r.ok) return r;
      if (productIds) return syncSupplierProducts(id, productIds);
      return ok(null);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: supplierKeys.all }),
  });
}
export function useMutationDeleteSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Result<null>> => {
      const r = await supabaseMutation(() => supabase.from('suppliers').delete().eq('id', id));
      return r.ok ? ok(null) : r;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: supplierKeys.all }),
  });
}

import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { TablesInsert, TablesUpdate } from '@shared/lib/supabase.types';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';
import { createPendingAction } from '../pendingActions';

// ─── Tool Definitions (Claude API format) ────────────────────────────────────

export const menuToolDefinitions = [
  {
    name: 'get_menu',
    description: 'Returns the full list of active products in the POS menu.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category_id: { type: 'string', description: 'Optional: filter by category UUID' },
      },
      required: [],
    },
  },
  {
    name: 'add_product',
    description: 'Creates a new product in the menu.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        price: { type: 'number' },
        category_id: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name', 'price'],
    },
  },
  {
    name: 'update_product',
    description: 'Updates an existing product by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        price: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'deactivate_product',
    description: 'Soft-deletes a product by setting is_active=false. Requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bulk_import_products',
    description: 'Inserts multiple products at once. Requires confirmation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              price: { type: 'number' },
              category_id: { type: 'string' },
            },
            required: ['name', 'price'],
          },
        },
      },
      required: ['products'],
    },
  },
] as const;

// ─── Implementations ─────────────────────────────────────────────────────────

export async function getMenu(
  args: { category_id?: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  let q = supabase.from('products').select('id, name, base_price, category_id').is('deleted_at', null);
  if (args.category_id) q = q.eq('category_id', args.category_id);
  const { data, error } = await q;
  const result = error ? err({ code: 'AGENT_ERROR' as const, message: error.message }) : ok(data);
  void logAgentAction('get_menu', args as Record<string, unknown>, data, { ...ctx, durationMs: Date.now() - t0 });
  return result;
}

// products.category_id is NOT NULL (see products_and_categories migration) but
// the agent's own extraction/tool-call surfaces (vision.ts, chat-driven
// add_product) never supply one — every write through here used to fail with
// a raw Postgres 400 until a category was resolved. Fall back to a shared
// "Uncategorized" category (created on first use) instead of relaxing the
// NOT NULL constraint, so no schema change is needed.
let uncategorizedCategoryIdCache: string | null = null;

async function resolveCategoryId(categoryId?: string): Promise<string> {
  if (categoryId) return categoryId;
  if (uncategorizedCategoryIdCache) return uncategorizedCategoryIdCache;

  const { data: existing } = await supabase
    .from('categories')
    .select('id')
    .eq('name', 'Uncategorized')
    .maybeSingle();
  if (existing) {
    uncategorizedCategoryIdCache = existing.id;
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from('categories')
    .insert({ name: 'Uncategorized' } as TablesInsert<'categories'>)
    .select('id')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  uncategorizedCategoryIdCache = created.id;
  return created.id;
}

export async function addProduct(
  args: { name: string; price: number; category_id?: string; description?: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const categoryId = await resolveCategoryId(args.category_id);
  const { data, error } = await supabase.from('products').insert({ name: args.name, base_price: args.price, category_id: categoryId } as TablesInsert<'products'>).select().single();
  const result = error ? err({ code: 'AGENT_ERROR' as const, message: error.message }) : ok(data);
  void logAgentAction('add_product', args as Record<string, unknown>, data, { ...ctx, durationMs: Date.now() - t0 });
  return result;
}

export async function updateProduct(
  args: { id: string; name?: string; price?: number; description?: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch['name'] = args.name;
  if (args.price !== undefined) patch['base_price'] = args.price;
  const { data, error } = await supabase.from('products').update(patch as TablesUpdate<'products'>).eq('id', args.id).select().single();
  const result = error ? err({ code: 'AGENT_ERROR' as const, message: error.message }) : ok(data);
  void logAgentAction('update_product', args as Record<string, unknown>, data, { ...ctx, durationMs: Date.now() - t0 });
  return result;
}

async function _executeDeactivateProduct(
  args: Record<string, unknown>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const { id } = args as { id: string };
  const t0 = Date.now();
  const { data, error } = await supabase.from('products').update({ deleted_at: new Date().toISOString() } as TablesUpdate<'products'>).eq('id', id).select().single();
  const result = error ? err({ code: 'AGENT_ERROR' as const, message: error.message }) : ok(data);
  void logAgentAction('deactivate_product', args, data, { ...ctx, durationMs: Date.now() - t0 });
  return result;
}

export async function deactivateProduct(
  args: { id: string },
  _ctx: AgentActionContext
): Promise<Result<unknown>> {
  const { data: product } = await supabase.from('products').select('name, is_active').eq('id', args.id).single();
  if (!product) return err({ code: 'NOT_FOUND' as const, message: `Product not found: ${args.id}. Use find_product to get real IDs.` });
  const preview = { action: 'deactivate_product', id: args.id, name: (product as { name?: string }).name };
  const token = createPendingAction('deactivate_product', args as Record<string, unknown>, preview, _executeDeactivateProduct);
  return ok({ pending: true, confirm_token: token, preview });
}

async function _executeBulkImportProducts(
  args: Record<string, unknown>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const { products } = args as { products: Array<{ name: string; price: number; category_id?: string }> };
  const t0 = Date.now();
  const fallbackCategoryId = await resolveCategoryId();
  const rows = products.map((p) => ({
    name: p.name,
    base_price: p.price,
    category_id: p.category_id ?? fallbackCategoryId,
  }));
  const { data, error } = await supabase.from('products').insert(rows as TablesInsert<'products'>[]).select();
  const result = error ? err({ code: 'AGENT_ERROR' as const, message: error.message }) : ok(data);
  void logAgentAction('bulk_import_products', args, { count: rows.length }, { ...ctx, durationMs: Date.now() - t0 });
  return result;
}

export function bulkImportProducts(
  args: { products: Array<{ name: string; price: number; category_id?: string }> },
  _ctx: AgentActionContext
): Result<unknown> {
  const preview = { action: 'bulk_import_products', count: args.products.length, products: args.products.slice(0, 5) };
  const token = createPendingAction('bulk_import_products', args as Record<string, unknown>, preview, _executeBulkImportProducts);
  return ok({ pending: true, confirm_token: token, preview });
}

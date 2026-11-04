import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';

export const reportToolDefinitions = [
  {
    name: 'generate_sales_report',
    description: 'Returns total sales and order count for a date range.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'ISO date string start (inclusive)' },
        to:   { type: 'string', description: 'ISO date string end (inclusive)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_daily_summary',
    description: 'Returns total revenue, order count, and top product for today.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_top_products',
    description: 'Returns the top N best-selling products by quantity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'How many products to return (default 5)' },
        days:  { type: 'number', description: 'Look-back window in days (default 7)' },
      },
      required: [],
    },
  },
] as const;

export async function generateSalesReport(
  args: { from: string; to: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from('payments')
    .select('amount, created_at')
    .gte('created_at', args.from)
    .lte('created_at', args.to + 'T23:59:59Z');

  if (error) {
    void logAgentAction('generate_sales_report', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }

  const total = data.reduce((sum, p) => sum + p.amount, 0);
  const result = { from: args.from, to: args.to, total_revenue: total, order_count: data.length };
  void logAgentAction('generate_sales_report', args as Record<string, unknown>, result, { ...ctx, durationMs: Date.now() - t0 });
  return ok(result);
}

export async function getDailySummary(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('payments')
    .select('amount')
    .gte('created_at', today + 'T00:00:00Z')
    .lte('created_at', today + 'T23:59:59Z');

  if (error) {
    void logAgentAction('get_daily_summary', {}, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }

  const total = data.reduce((sum, p) => sum + p.amount, 0);
  const result = { date: today, total_revenue: total, order_count: data.length };
  void logAgentAction('get_daily_summary', {}, result, { ...ctx, durationMs: Date.now() - t0 });
  return ok(result);
}

export async function getTopProducts(
  args: { limit?: number; days?: number },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const limit = args.limit ?? 5;
  const days = args.days ?? 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('order_items')
    .select('product_id, quantity, products(name)')
    .gte('created_at', since);

  if (error) {
    void logAgentAction('get_top_products', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }

  const totals: Record<string, { name: string; qty: number }> = {};
  for (const item of data) {
    const pid = item.product_id;
    const name = (item.products as { name?: string } | null)?.name ?? pid;
    const existing = totals[pid];
    if (existing) {
      existing.qty += item.quantity;
    } else {
      totals[pid] = { name, qty: item.quantity };
    }
  }

  const ranked = Object.entries(totals)
    .sort(([, a], [, b]) => b.qty - a.qty)
    .slice(0, limit)
    .map(([id, v]) => ({ product_id: id, name: v.name, quantity_sold: v.qty }));

  void logAgentAction('get_top_products', args as Record<string, unknown>, ranked, { ...ctx, durationMs: Date.now() - t0 });
  return ok(ranked);
}

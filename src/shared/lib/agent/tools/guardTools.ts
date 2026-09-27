import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';
import { consumePendingAction, cancelPendingAction } from '../pendingActions';

// ─── Write rate guard ─────────────────────────────────────────────────────────

const WRITE_WINDOW_MS = 60_000;
const WRITE_LIMIT = 10;
const writeLog: number[] = [];

export function checkWriteRateGuard(): Result<never> | null {
  const now = Date.now();
  const cutoff = now - WRITE_WINDOW_MS;
  // Remove old entries in-place
  let i = 0;
  while (i < writeLog.length && (writeLog[i] ?? 0) < cutoff) i++;
  writeLog.splice(0, i);

  if (writeLog.length >= WRITE_LIMIT) {
    return err({
      code: 'VALIDATION_ERROR' as const,
      message: `Too many write operations (${String(writeLog.length)} in last 60s, limit ${String(WRITE_LIMIT)}). Wait before retrying.`,
    });
  }
  writeLog.push(now);
  return null;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const guardToolDefinitions = [
  {
    name: 'find_product',
    description: 'Fuzzy name search for a product. Always use this to get a real product_id before calling add_items_to_tab or any product write tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Product name or partial name to search' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_tab',
    description: 'Finds open tabs by customer name or table number. Always use this to get a real tab_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string', description: 'Partial customer name (case-insensitive)' },
        table_number:  { type: 'number', description: 'Exact table number' },
      },
      required: [],
    },
  },
  {
    name: 'confirm_action',
    description: 'Executes a previously staged destructive action using its confirm_token. Call this after the user confirms.',
    input_schema: {
      type: 'object' as const,
      properties: {
        token: { type: 'string', description: 'The confirm_token returned by the staged action' },
      },
      required: ['token'],
    },
  },
  {
    name: 'cancel_action',
    description: 'Cancels a previously staged action using its confirm_token.',
    input_schema: {
      type: 'object' as const,
      properties: {
        token: { type: 'string', description: 'The confirm_token to cancel' },
      },
      required: ['token'],
    },
  },
] as const;

// ─── Implementations ──────────────────────────────────────────────────────────

export async function findProduct(
  args: { name: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from('products')
    .select('id, name, base_price, category_id, is_active')
    .ilike('name', `%${args.name}%`)
    .is('deleted_at', null)
    .eq('is_active', true)
    .order('name', { ascending: true })
    .limit(10);

  if (error) {
    void logAgentAction('find_product', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  if (data.length === 0) {
    return err({ code: 'NOT_FOUND' as const, message: `No active products matching "${args.name}". Try a different name or call get_menu.` });
  }
  void logAgentAction('find_product', args as Record<string, unknown>, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function findTab(
  args: { customer_name?: string; table_number?: number },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();

  if (!args.customer_name && args.table_number === undefined) {
    return err({ code: 'VALIDATION_ERROR' as const, message: 'Provide customer_name or table_number.' });
  }

  let q = supabase
    .from('tabs')
    .select('id, customer_name, table_number, status, opened_at')
    .eq('status', 'open')
    .is('deleted_at', null);

  if (args.customer_name) q = q.ilike('customer_name', `%${args.customer_name}%`);
  if (args.table_number !== undefined) q = q.eq('table_number', args.table_number);

  const { data, error } = await q.order('opened_at', { ascending: false }).limit(10);

  if (error) {
    void logAgentAction('find_tab', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  if (data.length === 0) {
    return err({ code: 'NOT_FOUND' as const, message: `No open tab found matching the given criteria.` });
  }
  void logAgentAction('find_tab', args as Record<string, unknown>, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function confirmAction(
  args: { token: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const pending = consumePendingAction(args.token);
  if (!pending) {
    return err({
      code: 'NOT_FOUND' as const,
      message: `No pending action for token "${args.token}". It may have expired (5 min TTL) or already been executed.`,
    });
  }

  const rateErr = checkWriteRateGuard();
  if (rateErr) return rateErr;

  void logAgentAction('confirm_action', { token: args.token, tool: pending.toolName }, null, ctx);
  return pending.executor(pending.args, ctx);
}

export function cancelAction(
  args: { token: string },
  _ctx: AgentActionContext
): Result<unknown> {
  const cancelled = cancelPendingAction(args.token);
  if (!cancelled) {
    return err({ code: 'NOT_FOUND' as const, message: `No pending action for token "${args.token}".` });
  }
  return ok({ cancelled: true, token: args.token });
}

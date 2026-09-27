import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';
import { getTerminalId } from '@shared/lib/terminal';
import { createPendingAction } from '../pendingActions';

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const posToolDefinitions = [
  // ── Tab reads ──
  {
    name: 'list_tabs',
    description: 'Lists all currently open tabs with customer name, table number, and item count.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_tab',
    description: 'Returns full details of a single tab including all order items.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tab_id: { type: 'string', description: 'UUID of the tab' },
      },
      required: ['tab_id'],
    },
  },
  // ── Tab writes ──
  {
    name: 'open_tab',
    description: 'Opens a new tab for a customer. Requires an open caja session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string' },
        table_number:  { type: 'number', description: 'Omit for bar / no-table orders' },
        notes:         { type: 'string' },
      },
      required: ['customer_name'],
    },
  },
  {
    name: 'close_tab',
    description: 'Previews closing an open tab and creates a confirmation token. Call confirm_action to execute.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tab_id: { type: 'string', description: 'UUID from list_tabs or find_tab' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'add_items_to_tab',
    description: 'Adds products to a tab. Use find_product to get real product_id — never invent IDs. Price is always fetched from DB.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tab_id: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'Real UUID from get_menu or find_product' },
              quantity:   { type: 'number' },
            },
            required: ['product_id', 'quantity'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['tab_id', 'items'],
    },
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveStaffContext(
  userId: string | undefined
): Promise<{ staffId: string; shiftId: string } | null> {
  if (userId) {
    const { data } = await supabase
      .from('shifts')
      .select('id, staff_id')
      .eq('staff_id', userId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { staffId: data.staff_id, shiftId: data.id };
  }
  const { data } = await supabase
    .from('shifts')
    .select('id, staff_id')
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { staffId: data.staff_id, shiftId: data.id };
}

async function resolveOpenCajaId(): Promise<string | null> {
  const { data } = await supabase
    .from('caja_sessions')
    .select('id')
    .eq('status', 'open')
    .eq('terminal_id', getTerminalId())
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Returns error message string if row not found, null if OK.
// Dynamic table name requires a local any cast — caller validates table names.
async function assertExists(
  table: string,
  id: string
): Promise<string | null> {
  // Dynamic table name cannot be statically typed — justified cast (caller validates table names)
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  const { count } = await (supabase as any)
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('id', id);
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  return ((count as number | null) ?? 0) > 0 ? null : `No ${table} row with id ${id}`;
}

// ─── Tab implementations ──────────────────────────────────────────────────────

export async function listTabs(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from('tabs')
    .select('id, customer_name, table_number, status, opened_at, staff_id')
    .eq('status', 'open')
    .is('deleted_at', null)
    .order('opened_at', { ascending: false });

  if (error) {
    void logAgentAction('list_tabs', {}, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('list_tabs', {}, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function getTab(
  args: { tab_id: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();

  const missing = await assertExists('tabs', args.tab_id);
  if (missing) return err({ code: 'NOT_FOUND' as const, message: missing });

  const { data, error } = await supabase
    .from('tabs')
    .select(`
      id, customer_name, table_number, status, opened_at, notes,
      order_items ( id, product_id, quantity, unit_price, notes,
        products ( name )
      )
    `)
    .eq('id', args.tab_id)
    .is('deleted_at', null)
    .single();

  if (error) {
    void logAgentAction('get_tab', args, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('get_tab', args, data, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function openTab(
  args: { customer_name: string; table_number?: number; notes?: string },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();

  const staff = await resolveStaffContext(ctx.userId);
  if (!staff) return err({ code: 'AGENT_ERROR' as const, message: 'No active shift. Clock in first.' });

  const cajaId = await resolveOpenCajaId();
  if (!cajaId) return err({ code: 'CAJA_CLOSED' as const, message: 'No open caja session. Open caja first.' });

  const { data, error } = await supabase
    .from('tabs')
    .insert({
      customer_name:   args.customer_name,
      table_number:    args.table_number ?? null,
      staff_id:        staff.staffId,
      shift_id:        staff.shiftId,
      status:          'open',
      notes:           args.notes ?? null,
      caja_session_id: cajaId,
    })
    .select('id, customer_name, table_number, status, opened_at')
    .single();

  if (error) {
    void logAgentAction('open_tab', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('open_tab', args as Record<string, unknown>, data, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

// Internal executor — called by confirm_action
async function _executeCloseTab(
  args: Record<string, unknown>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const { tab_id } = args as { tab_id: string };
  const t0 = Date.now();

  // tabs has a bump_version_on_update trigger (Phase 15) that rejects any
  // UPDATE not explicitly advancing `version` by 1 — fetch it first.
  const { data: versionRow, error: versionErr } = await supabase
    .from('tabs')
    .select('version')
    .eq('id', tab_id)
    .single();

  if (versionErr) {
    void logAgentAction('close_tab', args, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: versionErr.message });
  }

  const { data, error } = await supabase
    .from('tabs')
    .update({ status: 'closed', closed_at: new Date().toISOString(), version: versionRow.version + 1 })
    .eq('id', tab_id)
    .eq('status', 'open')
    .eq('version', versionRow.version)
    .select('id, status, closed_at')
    .single();

  if (error) {
    void logAgentAction('close_tab', args, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('close_tab', args, data, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

// Public tool — builds preview + pending action
export async function closeTab(
  args: { tab_id: string },
  _ctx: AgentActionContext
): Promise<Result<unknown>> {
  const missing = await assertExists('tabs', args.tab_id);
  if (missing) return err({ code: 'NOT_FOUND' as const, message: missing });

  const { data: tab } = await supabase
    .from('tabs')
    .select('customer_name, table_number, status')
    .eq('id', args.tab_id)
    .single();

  if ((tab as { status?: string } | null)?.status !== 'open') {
    return err({ code: 'AGENT_ERROR' as const, message: 'Tab is not open.' });
  }

  const preview = {
    action: 'close_tab',
    tab_id: args.tab_id,
    customer_name: (tab as { customer_name?: string } | null)?.customer_name,
    table_number:  (tab as { table_number?: number } | null)?.table_number,
  };

  const token = createPendingAction('close_tab', args as Record<string, unknown>, preview, _executeCloseTab);
  return ok({ pending: true, confirm_token: token, preview });
}

export async function addItemsToTab(
  args: {
    tab_id: string;
    items: Array<{ product_id: string; quantity: number }>;
    notes?: string;
  },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();

  // Pre-flight: tab must exist
  const tabMissing = await assertExists('tabs', args.tab_id);
  if (tabMissing) return err({ code: 'NOT_FOUND' as const, message: tabMissing });

  // Pre-flight: all product IDs must exist
  const productIds = args.items.map((i) => i.product_id);
  const { data: products, error: prodErr } = await supabase
    .from('products')
    .select('id, name, base_price')
    .in('id', productIds)
    .is('deleted_at', null);

  if (prodErr) return err({ code: 'AGENT_ERROR' as const, message: prodErr.message });

  const foundIds = new Set(products.map((p) => p.id));
  const missing = productIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return err({ code: 'NOT_FOUND' as const, message: `Products not found: ${missing.join(', ')}. Use find_product to get real IDs.` });
  }

  const staff = await resolveStaffContext(ctx.userId);
  if (!staff) return err({ code: 'AGENT_ERROR' as const, message: 'No active shift. Clock in first.' });

  // Build price map — DB price always wins over any Claude-supplied value
  const priceMap = Object.fromEntries(products.map((p) => [p.id, p.base_price]));

  const { data, error } = await supabase.rpc('create_order_with_items', {
    p_tab_id:         args.tab_id,
    p_staff_id:       staff.staffId,
    p_status:         'pending',
    p_notes:          args.notes ?? '',
    p_items:          args.items.map((i) => ({
      product_id:           i.product_id,
      quantity:             i.quantity,
      unit_price:           priceMap[i.product_id] ?? 0,
      modifier_ids:         [],
      modifier_price_delta: 0,
      notes:                '',
    })),
    p_skip_depletion: false,
  });

  if (error) {
    void logAgentAction('add_items_to_tab', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }

  void logAgentAction('add_items_to_tab', args as Record<string, unknown>, { tab_id: args.tab_id, item_count: args.items.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}


import type { Result } from '@shared/lib/result';
import { err } from '@shared/lib/result';
import type { AgentActionContext } from '@shared/lib/telemetry';
import { checkDbConnection, getRecentErrors, getAgentAuditLog, runDiagnostic, generateDiagnosticReport, diagnosticToolDefinitions } from './diagnosticTools';
import {
  findProduct, findTab, confirmAction, cancelAction,
  guardToolDefinitions, checkWriteRateGuard,
} from './guardTools';
import { getMenu, addProduct, updateProduct, deactivateProduct, bulkImportProducts, menuToolDefinitions } from './menuTools';
import {
  listTabs, getTab, openTab, closeTab, addItemsToTab,
  posToolDefinitions,
} from './posTools';
import { generateSalesReport, getDailySummary, getTopProducts, reportToolDefinitions } from './reportTools';
import { getPosStatus, getCurrentShift, systemToolDefinitions } from './systemTools';

// confirm_action is executable (see the switch below, for the UI's own
// click-through path in useAgent.ts) but never offered to the model —
// brain.ts's tool loop also refuses a model-issued confirm_action as a
// backstop.
export const allToolDefinitions = [
  ...guardToolDefinitions,   // lookup tools first — Claude should reach for these
  ...posToolDefinitions,
  ...menuToolDefinitions,
  ...reportToolDefinitions,
  ...diagnosticToolDefinitions,
  ...systemToolDefinitions,
].filter((t) => t.name !== 'confirm_action');

// Write tools subject to rate guard (also used by brain.ts to know whether a
// write has already run in the current attempt, so a failure afterward isn't
// silently retried into a duplicate write).
export const WRITE_TOOLS = new Set([
  'open_tab', 'close_tab', 'add_items_to_tab',
  'add_product', 'update_product', 'deactivate_product', 'bulk_import_products',
  'confirm_action',
]);

// Data minimization before a tool result reaches the model — customer phone
// numbers are masked to their last 4 digits, customer names are kept (needed
// to find a tab), and any staff email or pin field is dropped. No tool
// selects a phone/email/pin column today, so this is a defensive seam for a
// select list that grows one later, not a fix for a field any tool currently
// sends to the model.
function redactForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v: unknown) => redactForModel(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // Anchored so a future key like `shipping`/`mapping`/`topping` (all of
      // which contain "pin" as a substring) doesn't get dropped by accident.
      if (/^(pin|.*_pin)$|email/i.test(key)) continue;
      if (/phone/i.test(key) && typeof v === 'string') {
        out[key] = v.length > 4 ? `***${v.slice(-4)}` : v;
        continue;
      }
      out[key] = redactForModel(v);
    }
    return out;
  }
  return value;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  // Rate guard for all write tools
  if (WRITE_TOOLS.has(name)) {
    const rateErr = checkWriteRateGuard();
    if (rateErr) return rateErr;
  }

  const result = await dispatchTool(name, args, ctx);
  return result.ok ? { ok: true, data: redactForModel(result.data) } : result;
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  switch (name) {
    // ── Guard / lookup ──
    case 'find_product':    return findProduct(args as { name: string }, ctx);
    case 'find_tab':        return findTab(args as { customer_name?: string; table_number?: number }, ctx);
    case 'confirm_action':  return confirmAction(args as { token: string }, ctx);
    case 'cancel_action':   return cancelAction(args as { token: string }, ctx);
    // ── Menu ──
    case 'get_menu':             return getMenu(args as { category_id?: string }, ctx);
    case 'add_product':          return addProduct(args as { name: string; price: number; category_id?: string }, ctx);
    case 'update_product':       return updateProduct(args as { id: string; name?: string; price?: number }, ctx);
    case 'deactivate_product':   return deactivateProduct(args as { id: string }, ctx);
    case 'bulk_import_products': return bulkImportProducts(args as { products: Array<{ name: string; price: number; category_id?: string }> }, ctx);
    // ── Reports ──
    case 'generate_sales_report': return generateSalesReport(args as { from: string; to: string }, ctx);
    case 'get_daily_summary':     return getDailySummary({} as Record<string, never>, ctx);
    case 'get_top_products':      return getTopProducts(args as { limit?: number; days?: number }, ctx);
    // ── Diagnostics ──
    case 'check_db_connection':        return checkDbConnection({} as Record<string, never>, ctx);
    case 'get_recent_errors':          return getRecentErrors(args as { days?: number; limit?: number }, ctx);
    case 'get_agent_audit_log':        return getAgentAuditLog(args as { days?: number; limit?: number }, ctx);
    case 'run_diagnostic':             return runDiagnostic({} as Record<string, never>, ctx);
    case 'generate_diagnostic_report': return generateDiagnosticReport({} as Record<string, never>, ctx);
    // ── System ──
    case 'get_pos_status':    return getPosStatus({} as Record<string, never>, ctx);
    case 'get_current_shift': return getCurrentShift({} as Record<string, never>, ctx);
    // ── Tabs ──
    case 'list_tabs':        return listTabs({} as Record<string, never>, ctx);
    case 'get_tab':          return getTab(args as { tab_id: string }, ctx);
    case 'open_tab':         return openTab(args as { customer_name: string; table_number?: number; notes?: string }, ctx);
    case 'close_tab':        return closeTab(args as { tab_id: string }, ctx);
    case 'add_items_to_tab': return addItemsToTab(args as { tab_id: string; items: Array<{ product_id: string; quantity: number }>; notes?: string }, ctx);
    default:
      return err({ code: 'TOOL_EXECUTION_ERROR' as const, message: `Unknown tool: ${name}` });
  }
}

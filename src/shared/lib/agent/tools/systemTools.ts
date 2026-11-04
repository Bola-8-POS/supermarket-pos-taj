import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';

export const systemToolDefinitions = [
  {
    name: 'get_pos_status',
    description: 'Returns current POS status: open tabs, caja state.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_current_shift',
    description: 'Returns the currently clocked-in staff members.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
] as const;

export async function getPosStatus(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const [tabs, caja] = await Promise.all([
    supabase.from('tabs').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('caja_sessions').select('id, opened_at').is('closed_at', null).limit(1).maybeSingle(),
  ]);

  if (tabs.error ?? caja.error) {
    const msg = tabs.error?.message ?? caja.error?.message ?? 'Unknown';
    void logAgentAction('get_pos_status', {}, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: msg });
  }

  const result = {
    open_tabs: tabs.count ?? 0,
    caja_open: caja.data !== null,
    caja_opened_at: caja.data?.opened_at ?? null,
  };
  void logAgentAction('get_pos_status', {}, result, { ...ctx, durationMs: Date.now() - t0 });
  return ok(result);
}

export async function getCurrentShift(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const { data, error } = await supabase
    .from('shifts')
    .select('id, clock_in, profiles(id, name, role)')
    .is('clock_out', null)
    .order('clock_in', { ascending: false });

  if (error) {
    void logAgentAction('get_current_shift', {}, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('get_current_shift', {}, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

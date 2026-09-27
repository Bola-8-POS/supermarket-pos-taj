import { ok, err } from '@shared/lib/result';
import type { Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { logAgentAction } from '@shared/lib/telemetry';
import type { AgentActionContext } from '@shared/lib/telemetry';


export const diagnosticToolDefinitions = [
  {
    name: 'check_db_connection',
    description: 'Checks if the Supabase database is reachable.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_recent_errors',
    description: 'Returns recent errors from pos_error_log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Look-back window in days (default 7)' },
        limit: { type: 'number', description: 'Max rows to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_agent_audit_log',
    description: 'Returns recent agent tool invocations from agent_audit_log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days:  { type: 'number' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'run_diagnostic',
    description: 'Runs a quick health check: DB connection, table counts, recent errors.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'generate_diagnostic_report',
    description:
      'Generates a full markdown diagnostic report for the last 7 days: system status, error breakdown, affected components, and recommended actions. Trigger with "generar reporte" or "generate report".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
] as const;

export async function checkDbConnection(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const { error } = await supabase.from('products').select('id').limit(1);
  const result = error
    ? { connected: false, error: error.message }
    : { connected: true };
  void logAgentAction('check_db_connection', {}, result, { ...ctx, durationMs: Date.now() - t0 });
  return ok(result);
}

export async function getRecentErrors(
  args: { days?: number; limit?: number },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const days = args.days ?? 7;
  const limit = args.limit ?? 20;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('pos_error_log')
    .select('id, created_at, error_code, message, component')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    void logAgentAction('get_recent_errors', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('get_recent_errors', args as Record<string, unknown>, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function getAgentAuditLog(
  args: { days?: number; limit?: number },
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const days = args.days ?? 7;
  const limit = args.limit ?? 20;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('agent_audit_log')
    .select('id, created_at, tool_name, user_role, duration_ms')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    void logAgentAction('get_agent_audit_log', args as Record<string, unknown>, null, { ...ctx, durationMs: Date.now() - t0 });
    return err({ code: 'AGENT_ERROR' as const, message: error.message });
  }
  void logAgentAction('get_agent_audit_log', args as Record<string, unknown>, { count: data.length }, { ...ctx, durationMs: Date.now() - t0 });
  return ok(data);
}

export async function runDiagnostic(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const [dbCheck, errorCount, productCount] = await Promise.all([
    supabase.from('products').select('id').limit(1),
    supabase.from('pos_error_log').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86400000 * 7).toISOString()),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  const result = {
    db_connected: !dbCheck.error,
    errors_last_7d: errorCount.count ?? 0,
    active_products: productCount.count ?? 0,
    checked_at: new Date().toISOString(),
  };
  void logAgentAction('run_diagnostic', {}, result, { ...ctx, durationMs: Date.now() - t0 });
  return ok(result);
}

interface ErrorRow {
  error_code: string;
  message: string;
  component: string | null;
  created_at: string;
}

interface AuditRow {
  tool_name: string;
  duration_ms: number | null;
}

export async function generateDiagnosticReport(
  _args: Record<string, never>,
  ctx: AgentActionContext
): Promise<Result<unknown>> {
  const t0 = Date.now();
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const date = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });

  const [dbCheck, errorRes, auditRes] = await Promise.all([
    supabase.from('products').select('id').limit(1),
    supabase.from('pos_error_log')
      .select('error_code, message, component, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('agent_audit_log')
      .select('tool_name, duration_ms')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const dbConnected = !dbCheck.error;
  const errors: ErrorRow[] = (errorRes.data as ErrorRow[] | null) ?? [];
  const auditEntries: AuditRow[] = (auditRes.data as AuditRow[] | null) ?? [];

  const criticalCodes = new Set(['PAYMENT_DECLINED', 'SUPABASE_ERROR', 'TAURI_ERROR']);
  const hasCritical = errors.some((e) => criticalCodes.has(e.error_code));
  const statusLabel = !dbConnected || hasCritical
    ? '🔴 CRÍTICO'
    : errors.length > 5
    ? '⚠️ DEGRADADO'
    : '✅ OPERACIONAL';

  const affectedComponents = [
    ...new Set(errors.map((e) => e.component).filter((c): c is string => c !== null)),
  ];

  const errorCodeCounts = errors.reduce<Record<string, number>>((acc, e) => {
    acc[e.error_code] = (acc[e.error_code] ?? 0) + 1;
    return acc;
  }, {});

  const toolUsageCounts = auditEntries.reduce<Record<string, number>>((acc, e) => {
    acc[e.tool_name] = (acc[e.tool_name] ?? 0) + 1;
    return acc;
  }, {});

  const errorBreakdown = Object.entries(errorCodeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `  - \`${code}\`: ${String(n)}`)
    .join('\n');

  const toolSummary = Object.entries(toolUsageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => `  - ${name}: ${String(n)} llamadas`)
    .join('\n');

  const recommendations: string[] = [];
  if (!dbConnected) recommendations.push('Verificar conectividad a Supabase — la base de datos no responde.');
  if (hasCritical) recommendations.push('Revisar errores críticos de pago o Tauri de inmediato.');
  if (errors.length > 10) recommendations.push('Volumen alto de errores — buscar patrón común en logs.');
  if (affectedComponents.length > 0)
    recommendations.push(`Inspeccionar componentes con errores: ${affectedComponents.join(', ')}.`);
  if (recommendations.length === 0) recommendations.push('No se requieren acciones inmediatas.');

  const sections: string[] = [
    `## Reporte de Diagnóstico POS — ${date}`,
    `### Estado del sistema: ${statusLabel}`,
    `### Errores recientes (últimos 7 días): ${String(errors.length)}`,
    `### Componentes afectados: ${affectedComponents.length > 0 ? affectedComponents.join(', ') : 'ninguno'}`,
  ];

  if (errorBreakdown) sections.push('', `### Distribución de errores\n${errorBreakdown}`);
  if (toolSummary) sections.push('', `### Herramientas más usadas\n${toolSummary}`);

  sections.push(
    '',
    `### Acciones recomendadas\n${recommendations.map((r, i) => `${String(i + 1)}. ${r}`).join('\n')}`
  );

  const report = sections.join('\n');

  void logAgentAction(
    'generate_diagnostic_report',
    {},
    { errorCount: errors.length, status: statusLabel },
    { ...ctx, durationMs: Date.now() - t0 }
  );

  return ok(report);
}

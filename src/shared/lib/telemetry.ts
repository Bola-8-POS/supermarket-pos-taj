import { logger } from '@shared/lib/logger';
import type { AppError } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Json } from '@shared/lib/supabase.types';


export interface TelemetryErrorContext {
  component: string | undefined;
  sessionId: string | undefined;
  userId: string | undefined;
}

export interface AgentActionContext {
  userId: string | undefined;
  userRole: string;
  durationMs: number | undefined;
}

/**
 * Persists an AppError (or raw Error) to pos_error_log.
 * Fire-and-forget — never throws.
 */
export async function logError(
  error: AppError | Error,
  context: Partial<TelemetryErrorContext> = {}
): Promise<void> {
  try {
    const isAppError = 'code' in error;
    const row = {
      error_code: isAppError ? error.code : 'UNKNOWN_ERROR',
      message: error.message,
      detail: isAppError ? (error.detail ?? null) : null,
      component: context.component ?? null,
      user_id: context.userId ?? null,
      session_id: context.sessionId ?? null,
      raw:
        isAppError && error.raw != null
          ? typeof error.raw === 'object'
            ? (error.raw as Json)
            : ({ value: JSON.stringify(error.raw) } as Json)
          : null,
    };

    const { error: sbError } = await supabase.from('pos_error_log').insert(row);
    if (sbError) {
      logger.warn('telemetry.logError.insert_failed', { detail: sbError.message });
    }
  } catch {
    // telemetry must never throw — silently ignore
  }
}

/**
 * Records an agent tool invocation to agent_audit_log.
 * Fire-and-forget — never throws.
 */
export async function logAgentAction(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  context: AgentActionContext
): Promise<void> {
  try {
    const row = {
      tool_name: toolName,
      args: args as Json,
      result:
        result != null
          ? typeof result === 'object'
            ? (result as Json)
            : ({ value: JSON.stringify(result) } as Json)
          : null,
      user_id: context.userId ?? null,
      user_role: context.userRole,
      duration_ms: context.durationMs ?? null,
    };

    const { error: sbError } = await supabase.from('agent_audit_log').insert(row);
    if (sbError) {
      logger.warn('telemetry.logAgentAction.insert_failed', { detail: sbError.message });
    }
  } catch {
    // telemetry must never throw — silently ignore
  }
}

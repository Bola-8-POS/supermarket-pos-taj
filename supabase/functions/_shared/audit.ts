/**
 * _shared/audit.ts — Edge Function audit helper (Deno runtime)
 *
 * Usage in edge functions:
 *   import { recordAudit } from '../_shared/audit.ts';
 *   await recordAudit(supabaseClient, {
 *     action: 'payment.process',
 *     entityType: 'payment',
 *     entityId: paymentId,
 *     after: paymentRow,
 *     source: 'edge',
 *   });
 *
 * recordAudit is fire-and-forget — it never throws.
 * Failures are logged to stderr (Supabase Edge Function logs).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface AuditParams {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  source?: 'rpc' | 'edge' | 'client' | 'trigger';
  actorId?: string | null;
  terminalId?: string | null;
}

export async function recordAudit(
  supabase: SupabaseClient,
  params: AuditParams
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId ?? null,
      before: params.before ?? null,
      after: params.after ?? null,
      source: params.source ?? 'edge',
      actor_id: params.actorId ?? null,
      terminal_id: params.terminalId ?? null,
    });

    if (error) {
      console.error('[audit] Failed to write audit log:', error.message, {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
      });
    }
  } catch (err) {
    // Audit failure MUST NOT propagate — log and continue
    console.error('[audit] Unexpected error writing audit log:', err);
  }
}

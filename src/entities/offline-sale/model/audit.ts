import { logger } from '@shared/lib/logger-instance';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';
import { offlineSaleTotal } from './replay-outcome';
/* eslint-disable i18next/no-literal-string -- audit action names and log events, not UI copy. */

export type OfflineSaleAuditAction = 'offline_sale_needs_review' | 'offline_sale_resolved';

/** Record fields come from storage; keep the audit row far below the server's 64 KB payload limit. */
export const clipAuditText = (value: string, max = 64): string => value.slice(0, max);

/**
 * What /audit needs to find a sale again (two-mode Plan 02b, Ruling 12): never the card
 * reference or the line items. `code` is added where the row records a refusal.
 */
export function offlineSaleAuditSummary(
  record: OfflineSale,
  code?: string | null
): Record<string, unknown> {
  return {
    receiptNumber: clipAuditText(record.receiptNumber),
    total: offlineSaleTotal(record) ?? null,
    soldAt: clipAuditText(record.soldAt),
    terminalId: record.request.terminalId ?? null,
    staffId: record.staffId,
    ...(code === undefined ? {} : { code }),
  };
}

/**
 * Writes one `record_audit` row for an offline sale. True only when the server stored it:
 * `record_audit` swallows its own failures and answers null, so a null id counts as not written.
 * The server records the signed-in user as the actor and ignores `actorId` (only the service
 * role may name one), so anything that must survive, such as the approving manager, belongs in
 * `after`. Never throws.
 */
export async function recordOfflineSaleAudit(
  record: OfflineSale,
  action: OfflineSaleAuditAction,
  entityId: string | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actorId: string = record.staffId
): Promise<boolean> {
  try {
    const res = await supabase.rpc('record_audit', {
      p_action: action,
      p_entity_type: 'payment',
      p_entity_id: entityId ?? null,
      p_before: before,
      p_after: after,
      // not 'rpc', the label the server RPCs use: this row is written by the client
      p_source: 'client',
      p_terminal_id: record.request.terminalId ?? getTerminalId(),
      p_user_id: actorId,
    } as never);
    if (res.error) {
      logger.warn('offline_sale.audit_failed', { saleId: record.id, message: res.error.message });
      return false;
    }
    // the generated type says a uuid; the function answers null when it swallowed its own failure
    const logId: unknown = res.data;
    if (logId === null || logId === undefined) {
      logger.warn('offline_sale.audit_not_recorded', { saleId: record.id });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('offline_sale.audit_threw', { saleId: record.id, error: e });
    return false;
  }
}

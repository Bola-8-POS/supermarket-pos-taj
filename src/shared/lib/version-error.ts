/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- helper deliberately erases supabase generic; record_audit is fire-and-forget across schema generations */
/**
 * VERSION-ERROR HELPER — Phase 15-03
 *
 * Centralised handler for STALE_VERSION / NOT_FOUND_VERSIONED conflict errors.
 * Used by mutation-hook `onError` callbacks across the 11 conflict-prone paths
 * (tabs, pool_sessions, caja_sessions). Lives in shared/lib so no entity needs
 * to import from another entity (FSD compliant — D-17 revised).
 *
 * Behavior:
 *  - STALE_VERSION → invalidateQueries + toast "Updated by another terminal — please retry"
 *                    + best-effort `record_audit` write (fire-and-forget; never throws)
 *  - NOT_FOUND_VERSIONED → invalidateQueries + toast "Record was deleted by another terminal."
 *  - any other code → returns false so the caller can fall through
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { logger } from './logger-instance';
import type { AppError } from './result';

/** Entity tables guarded by the version contract. */
type VersionedEntity = 'tabs' | 'pool_sessions' | 'caja_sessions';

export interface VersionErrorContext {
  queryClient: QueryClient;
  queryKey: QueryKey;
  entity: VersionedEntity;
  entityId: string;
  expectedVersion: number;
  supabase: SupabaseClient;
  terminalId: string;
}

/**
 * Handle a STALE_VERSION / NOT_FOUND_VERSIONED conflict surfaced by a versioned
 * mutation. Returns true if the error was handled, false otherwise.
 *
 * The audit RPC call is intentionally fire-and-forget (D-17 revised) — a terminal
 * crash between conflict and audit write is an accepted, documented limitation.
 */
export const handleVersionError = (error: AppError, ctx: VersionErrorContext): boolean => {
  if (error.code === 'STALE_VERSION') {
    void ctx.queryClient.invalidateQueries({ queryKey: ctx.queryKey });
    toast.error('Updated by another terminal — please retry');

    // Best-effort audit (D-17 revised). Fire-and-forget, never await, never throw.
    try {
      const rpc = (ctx.supabase as any).rpc('record_audit', {
        p_action: 'conflict.stale_version',
        p_entity_type: ctx.entity,
        p_entity_id: ctx.entityId,
        p_before: { expected_version: ctx.expectedVersion, terminal_id: ctx.terminalId },
        p_after: null,
      });
      const promise = rpc && typeof rpc.then === 'function' ? rpc : null;
      if (promise) {
        promise
          .then((res: { error?: unknown } | null | undefined) => {
            if (res && res.error) {
              logger.warn('audit.write_failed', {
                entity: ctx.entity,
                entityId: ctx.entityId,
              });
            }
          })
          .catch(() => {
            logger.warn('audit.write_failed', { entity: ctx.entity, entityId: ctx.entityId });
          });
      }
    } catch {
      logger.warn('audit.write_failed', { entity: ctx.entity, entityId: ctx.entityId });
    }
    return true;
  }

  if (error.code === 'NOT_FOUND_VERSIONED') {
    void ctx.queryClient.invalidateQueries({ queryKey: ctx.queryKey });
    toast.error('Record was deleted by another terminal.');
    return true;
  }

  return false;
};

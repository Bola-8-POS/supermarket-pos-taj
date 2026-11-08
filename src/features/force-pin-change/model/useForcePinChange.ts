/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * useForcePinChange — TanStack mutation hook for calling the force_pin_change RPC.
 *
 * Uses `supabase as any` pre-regen cast — force_pin_change RPC added in Phase 14
 * (14-09) and not yet transcribed into supabase.types.ts.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { staffKeys } from '@entities/staff/model/queries';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type AppErrorCode, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

const db = supabase as any;

export interface ForcePinChangeInput {
  staffId: string;
}

export function useForcePinChange() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ staffId }: ForcePinChangeInput): Promise<Result<undefined>> => {
      const { data, error } = await db.rpc('force_pin_change', {
        p_staff_id: staffId,
        p_terminal_id: getTerminalId(),
      });

      if (error) {
        logger.error('force_pin_change.failed', { staffId, message: error.message as string });
        return err({
          code: 'SUPABASE_ERROR' as AppErrorCode,
          message:
            (error.message as string | undefined) ??
            i18n.t('featMgmt:forcePinChange.failedGeneric'),
          raw: error,
        });
      }

      if (!data?.ok) {
        logger.error('force_pin_change.unexpected_response', { staffId, data });
        return err({
          code: 'UNKNOWN_ERROR' as AppErrorCode,
          message: i18n.t('featMgmt:forcePinChange.failedGeneric'),
        });
      }

      return ok(undefined);
    },
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
      }
    },
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Pre-regen cast: role_permissions table added in Phase 13; supabase.types.ts extended manually.
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { rbacKeys } from '@entities/rbac';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { StaffAction, StaffRole } from '@shared/lib/rbac';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

const db = supabase as any;

export interface TogglePermissionInput {
  role: StaffRole;
  action: StaffAction;
  enabled: boolean;
}

export function useMutationTogglePermission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      role,
      action,
      enabled,
    }: TogglePermissionInput): Promise<Result<null>> => {
      if (enabled) {
        /* eslint-disable i18next/no-literal-string -- Supabase query-builder chain:
           table name, not UI copy */
        const { error } = await db
          .from('role_permissions')
          .insert({ role, action })
          .select()
          .single();
        /* eslint-enable i18next/no-literal-string */
        if (error) {
          logger.error('toggle-permission.enable.failed', { role, action, error });
          return err({
            code: 'SUPABASE_ERROR' as const,
            message:
              (error as { message?: string }).message ??
              i18n.t('featMgmt:togglePermission.enableFailed'),
          });
        }

        const auditRes = await db.rpc('record_audit', {
          p_action: 'permission.toggle',
          p_entity_type: 'permission',
          p_entity_id: null,
          p_before: null,
          p_after: { role, action },
          p_source: 'client',
          p_terminal_id: getTerminalId(),
          p_user_id: null,
        });
        if (auditRes?.error) {
          logger.warn('permission.toggle.audit_failed', {
            role,
            action,
            message: auditRes.error.message,
          });
        }

        return ok(null);
      }

      /* eslint-disable i18next/no-literal-string -- Supabase query-builder chain:
         table/column names, not UI copy */
      const { error } = await db
        .from('role_permissions')
        .delete()
        .eq('role', role)
        .eq('action', action);
      /* eslint-enable i18next/no-literal-string */
      if (error) {
        logger.error('toggle-permission.disable.failed', { role, action, error });
        return err({
          code: 'SUPABASE_ERROR' as const,
          message:
            (error as { message?: string }).message ??
            i18n.t('featMgmt:togglePermission.disableFailed'),
        });
      }

      const auditRes = await db.rpc('record_audit', {
        p_action: 'permission.toggle',
        p_entity_type: 'permission',
        p_entity_id: null,
        p_before: { role, action },
        p_after: null,
        p_source: 'client',
        p_terminal_id: getTerminalId(),
        p_user_id: null,
      });
      if (auditRes?.error) {
        logger.warn('permission.toggle.audit_failed', {
          role,
          action,
          message: auditRes.error.message,
        });
      }

      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: rbacKeys.list() });
      }
    },
  });
}

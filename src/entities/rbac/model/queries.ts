/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Pre-regen cast: role_permissions table added in Phase 13; supabase.types.ts extended manually.
import { useQuery } from '@tanstack/react-query';

import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { StaffAction, StaffRole } from '@shared/lib/rbac';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

const db = supabase as any;

/* eslint-disable i18next/no-literal-string -- TanStack Query cache-key
   namespace strings, not UI copy. */
export const rbacKeys = {
  all: ['role_permissions'] as const,
  list: () => [...rbacKeys.all, 'list'] as const,
};
/* eslint-enable i18next/no-literal-string */

export function useRolePermissions() {
  return useQuery({
    queryKey: rbacKeys.list(),
    queryFn: async (): Promise<Result<Map<StaffRole, Set<StaffAction>>>> => {
      const { data, error } = await db.from('role_permissions').select('*');
      if (error) {
        logger.error('useRolePermissions: query failed', { error });
        return err({
          code: 'SUPABASE_ERROR' as const,
          message: (error as { message?: string }).message ?? i18n.t('entities:common.unknownError'),
        });
      }
      const map = new Map<StaffRole, Set<StaffAction>>();
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const role = row['role'] as StaffRole;
        const action = row['action'] as StaffAction;
        let bucket = map.get(role);
        if (bucket === undefined) {
          bucket = new Set<StaffAction>();
          map.set(role, bucket);
        }
        bucket.add(action);
      }
      return ok(map);
    },
    staleTime: 30 * 1000,
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { staffKeys } from '@entities/staff/model/queries';
import { isOnline } from '@shared/lib/connectivity';
import type { SetStaffActiveSuccess } from '@shared/lib/edge-function-contracts';
import { callSetStaffActive } from '@shared/lib/edge-function-contracts';
import { err, networkOfflineError, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';
import { getTerminalId } from '@shared/lib/terminal';

export type DeactivateStaffInput = { staffId: string };

export function useDeactivateStaff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: DeactivateStaffInput
    ): Promise<Result<SetStaffActiveSuccess, AppError>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }
      return callSetStaffActive({
        staffId: input.staffId,
        active: false,
        terminalId: getTerminalId(),
      });
    },
    onSuccess: result => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
    },
  });
}

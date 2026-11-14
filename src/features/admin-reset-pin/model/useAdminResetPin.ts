import { useMutation, useQueryClient } from '@tanstack/react-query';

import { staffKeys } from '@entities/staff/model/queries';
import { isOnline } from '@shared/lib/connectivity';
import type {
  AdminResetPinRequest,
  AdminResetPinSuccess,
} from '@shared/lib/edge-function-contracts';
import { callAdminResetPin } from '@shared/lib/edge-function-contracts';
import { err, networkOfflineError, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';

export type AdminResetPinInput = AdminResetPinRequest;

export function useAdminResetPin() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (
      input: AdminResetPinInput
    ): Promise<Result<AdminResetPinSuccess, AppError>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }
      return callAdminResetPin(input);
    },
    onSuccess: result => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
    },
  });

  return mutation;
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { staffKeys } from '@entities/staff/model/queries';
import { isOnline } from '@shared/lib/connectivity';
import type { CreateStaffRequest, CreateStaffSuccess } from '@shared/lib/edge-function-contracts';
import { callCreateStaff } from '@shared/lib/edge-function-contracts';
import { err, networkOfflineError, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';

export type CreateStaffInput = CreateStaffRequest;

export function useCreateStaff() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: CreateStaffInput): Promise<Result<CreateStaffSuccess, AppError>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }
      return callCreateStaff(input);
    },
    onSuccess: result => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
    },
  });

  return mutation;
}

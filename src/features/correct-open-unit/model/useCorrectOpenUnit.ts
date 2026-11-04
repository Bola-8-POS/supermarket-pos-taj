import { toast } from 'sonner';
import { useMutationCorrectOpenUnit } from '@entities/open-unit';
import type { OpenUnitCorrection } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';

type CorrectOpenUnitArgs = OpenUnitCorrection & { productName: string };

type UseCorrectOpenUnitReturn = {
  correctUnit: (input: CorrectOpenUnitArgs) => Promise<boolean>;
  isSaving: boolean;
};

export function useCorrectOpenUnit(): UseCorrectOpenUnitReturn {
  const mutation = useMutationCorrectOpenUnit();

  const correctUnit = async ({ productName, ...input }: CorrectOpenUnitArgs): Promise<boolean> => {
    const result = await mutation.mutateAsync(input);
    if (!result.ok) {
      // D-08/T-27-20: pass the RPC's own message through unmodified — no
      // per-error-code copy substitution.
      toast.error(result.error.message);
      return false;
    }
    toast.success(i18n.t('featMgmt:correctOpenUnit.unitCorrected', { name: productName }));
    return true;
  };

  return { correctUnit, isSaving: mutation.isPending };
}

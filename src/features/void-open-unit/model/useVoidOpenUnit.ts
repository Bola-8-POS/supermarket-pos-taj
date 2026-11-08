import { toast } from 'sonner';
import { useMutationVoidOpenUnit } from '@entities/open-unit';
import i18n from '@shared/lib/i18n';

type VoidOpenUnitArgs = { openUnitId: string; reason: string; productName: string };

type UseVoidOpenUnitReturn = {
  voidUnit: (input: VoidOpenUnitArgs) => Promise<boolean>;
  isSaving: boolean;
};

export function useVoidOpenUnit(): UseVoidOpenUnitReturn {
  const mutation = useMutationVoidOpenUnit();

  const voidUnit = async ({ productName, ...input }: VoidOpenUnitArgs): Promise<boolean> => {
    const result = await mutation.mutateAsync(input);
    if (!result.ok) {
      // D-08/T-27-20: pass the RPC's own message through unmodified — no
      // per-error-code copy substitution.
      toast.error(result.error.message);
      return false;
    }
    toast.success(i18n.t('featMgmt:voidOpenUnit.unitVoided', { name: productName }));
    return true;
  };

  return { voidUnit, isSaving: mutation.isPending };
}

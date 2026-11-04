import { toast } from 'sonner';
import { useMutationOpenOpenUnit } from '@entities/open-unit';
import i18n from '@shared/lib/i18n';

type UseOpenOpenUnitReturn = {
  openUnit: (input: { productId: string; productName: string }) => Promise<string | null>;
  isSaving: boolean;
};

export function useOpenOpenUnit(): UseOpenOpenUnitReturn {
  const mutation = useMutationOpenOpenUnit();

  const openUnit = async ({
    productId,
    productName,
  }: {
    productId: string;
    productName: string;
  }): Promise<string | null> => {
    const result = await mutation.mutateAsync(productId);
    if (!result.ok) {
      // D-08: the RPC interpolates the live remaining count into this message —
      // pass it through verbatim, never substitute per-error-code copy here.
      toast.error(result.error.message);
      return null;
    }
    toast.success(i18n.t('featMgmt:openOpenUnit.unitOpened', { name: productName }));
    return result.data;
  };

  return { openUnit, isSaving: mutation.isPending };
}

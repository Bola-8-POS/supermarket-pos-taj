import { useCajaStore, useMutationCreateCajaEntry } from '@entities/caja';
import type { CajaEntryCreate, CajaEntryType } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { err } from '@shared/lib/result';

type RegisterEntryInput = {
  type: CajaEntryType;
  amount: number;
  concept: string;
  staffId: string;
};

export function useRegisterCajaEntry() {
  const mutation = useMutationCreateCajaEntry();
  const currentCaja = useCajaStore(s => s.currentCaja);

  const registerEntry = async (input: RegisterEntryInput) => {
    if (!currentCaja) {
      return err({ code: 'NOT_FOUND' as const, message: i18n.t('featOrders:registerCajaEntry.noOpenCaja') });
    }

    const payload: CajaEntryCreate = {
      cajaSessionId: currentCaja.id,
      type: input.type,
      amount: input.amount,
      concept: input.concept,
      staffId: input.staffId,
    };

    const result = await mutation.mutateAsync(payload);

    if (!result.ok) {
      logger.error('caja.entry.register.failed', { type: input.type });
      return result;
    }

    logger.info('caja.entry.registered', { type: input.type, amount: input.amount });
    return result;
  };

  return { registerEntry, isPending: mutation.isPending };
}

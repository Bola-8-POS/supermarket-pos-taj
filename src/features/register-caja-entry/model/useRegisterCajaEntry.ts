/**
 * useRegisterCajaEntry — wraps useMutationCreateCajaEntry (register_caja_entry RPC).
 *
 * The idempotency key is minted once per register-entry attempt (`??=`, same shape as
 * useProcessRefund.ts's idempotencyKeyRef) and passed through so a retried offline-queue
 * mutation or a duplicate submit replays instead of creating a second cash movement
 * (offline-first Plan 01, Task 4). RegisterCajaEntryDialog calls resetIdempotencyKey() when
 * the dialog closes, so the next entry mints a fresh key. If the RPC itself rejects the key
 * as a replay with mismatched arguments (VALIDATION_ERROR — see queries.ts's IDEMPOTENCY_*
 * mapping), the key is discarded right here too, so the dialog doesn't have to stay open to
 * avoid resubmitting a key that will keep failing the same way (fix-pass F3).
 */
import { useRef } from 'react';
import { useCajaStore, useMutationCreateCajaEntry } from '@entities/caja';
import type { CajaEntryCreate, CajaEntryType } from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
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
  const idempotencyKeyRef = useRef<string | undefined>(undefined);

  const registerEntry = async (input: RegisterEntryInput) => {
    if (!currentCaja) {
      return err({ code: 'NOT_FOUND' as const, message: i18n.t('featOrders:registerCajaEntry.noOpenCaja') });
    }

    // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
    idempotencyKeyRef.current ??= generateIdempotencyKey('caja_entry');

    const payload: CajaEntryCreate = {
      cajaSessionId: currentCaja.id,
      type: input.type,
      amount: input.amount,
      concept: input.concept,
      staffId: input.staffId,
      idempotencyKey: idempotencyKeyRef.current,
    };

    const result = await mutation.mutateAsync(payload);

    if (!result.ok) {
      logger.error('caja.entry.register.failed', { type: input.type });
      if (result.error.code === 'VALIDATION_ERROR') {
        // queries.ts's IDEMPOTENCY_* mapping returns VALIDATION_ERROR, so
        // discard the poisoned key now. A 23514 check-constraint violation
        // also maps to VALIDATION_ERROR (parseSupabaseError) and would hit
        // this branch too, but that rolls back with nothing committed, so
        // discarding here is harmless either way.
        idempotencyKeyRef.current = undefined;
      }
      return result;
    }

    logger.info('caja.entry.registered', { type: input.type, amount: input.amount });
    return result;
  };

  return {
    registerEntry,
    isPending: mutation.isPending,
    resetIdempotencyKey: () => {
      idempotencyKeyRef.current = undefined;
    },
  };
}

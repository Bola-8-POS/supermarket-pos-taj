/* eslint-disable import/order */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  callReceiveShipment,
  type ReceiveShipmentRequest,
} from '@shared/lib/edge-function-contracts';
import { inventoryKeys } from '@entities/inventory';
import { purchaseOrderKeys } from '@entities/purchase-order';

/** Fields that identify what a receiving submission actually does — anything
 * else in the request (or the key itself) is irrelevant to whether a retry
 * is "the same attempt" or a new one. */
function fingerprint(request: ReceiveShipmentRequest): string {
  return JSON.stringify({
    supplierId: request.supplierId,
    poId: request.poId ?? null,
    items: request.items,
  });
}

/**
 * One idempotency key per submission attempt: generated the first time
 * `mutate`/`mutateAsync` runs, reused across a retry of that same attempt
 * (the RPC replays the original result instead of receiving twice) — but
 * only while the request is still the same one. A key survives a failed
 * attempt on its own (the failure may have actually committed, and the
 * point of the key is to make that replay safe), so if the lines or the
 * supplier change before resubmitting, the fingerprint no longer matches
 * and a fresh key is generated instead of replaying the earlier, edited-away
 * attempt. Both are cleared once the attempt actually succeeds, so the next
 * submission starts clean.
 */
export function useReceiveShipment() {
  const queryClient = useQueryClient();
  const idempotencyKeyRef = useRef<string | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  return useMutation({
    mutationFn: (request: ReceiveShipmentRequest) => {
      const currentFingerprint = fingerprint(request);
      if (idempotencyKeyRef.current === null || fingerprintRef.current !== currentFingerprint) {
        idempotencyKeyRef.current = crypto.randomUUID();
        fingerprintRef.current = currentFingerprint;
      }
      return callReceiveShipment({ ...request, idempotencyKey: idempotencyKeyRef.current });
    },
    onSuccess: result => {
      if (result.ok) {
        idempotencyKeyRef.current = null;
        fingerprintRef.current = null;
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
        void queryClient.invalidateQueries({ queryKey: inventoryKeys.log() });
        void queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all });
      }
    },
  });
}

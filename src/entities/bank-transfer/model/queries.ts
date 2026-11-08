/* eslint-disable i18next/no-literal-string */
// i18next/no-literal-string: query-key namespace strings + multi-line Supabase
// chain args below are wire-protocol identifiers, not UI copy (mirrors
// entities/refund/model/queries.ts's 21-08 quirk note).
/**
 * entities/bank-transfer/model/queries.ts
 *
 * TanStack Query hooks for bank-transfer reconciliation data.
 */
import { useQuery } from '@tanstack/react-query';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import type { BankTransfer } from './types';

export const bankTransferKeys = {
  all: ['bank-transfers'] as const,
  lists: () => [...bankTransferKeys.all, 'list'] as const,
  pendingList: () => [...bankTransferKeys.lists(), 'pending'] as const,
  detail: (id: string) => [...bankTransferKeys.all, 'detail', id] as const,
};

// Selecting the parent payment's amount/reference_number and the payment's
// tab's customer_name — this table is 1:1 with payments (Plan 01), never with
// order_items, so no order-level join is needed. WR-04 fix (23-REVIEW.md):
// also embed the resolving staff member's name via the confirmed_by/disputed_by
// FKs (column-name hint, same pattern as entities/caja/model/queries.ts's
// opened_by_profile/closed_by_profile — the FK-constraint-name hint form
// doesn't parse under supabase-js's select-string type inference).
// Kept as one string literal (not `+`-concatenated) — supabase-js's select-string
// type inference relies on the literal type, which string concatenation widens
// to plain `string` and breaks (surfaces as data: GenericStringError[]).
const TRANSFER_SELECT =
  '*, payments!inner(amount, reference_number, tab_id, tabs!inner(customer_name)), confirmed_by_profile:profiles!confirmed_by(name), disputed_by_profile:profiles!disputed_by(name)';

function mapTransferRow(row: Record<string, unknown>): BankTransfer {
  const payment = row['payments'] as Record<string, unknown>;
  const tab = payment['tabs'] as Record<string, unknown>;
  const confirmedByProfile = row['confirmed_by_profile'] as Record<string, unknown> | null;
  const disputedByProfile = row['disputed_by_profile'] as Record<string, unknown> | null;
  const confirmedAt = row['confirmed_at'] as string | null;
  const disputedAt = row['disputed_at'] as string | null;
  return {
    id: row['id'] as string,
    paymentId: row['payment_id'] as string,
    referenceCode: (payment['reference_number'] as string | null) ?? '',
    amount: payment['amount'] as number,
    status: row['status'] as BankTransfer['status'],
    customerName: (tab['customer_name'] as string | null) ?? 'Walk-in',
    customerPhone: row['customer_phone'] as string | null,
    createdBy: row['created_by'] as string,
    createdAt: new Date(row['created_at'] as string),
    confirmedBy: row['confirmed_by'] as string | null,
    confirmedByName: (confirmedByProfile?.['name'] as string | undefined) ?? null,
    confirmedAt: confirmedAt ? new Date(confirmedAt) : null,
    disputedBy: row['disputed_by'] as string | null,
    disputedByName: (disputedByProfile?.['name'] as string | undefined) ?? null,
    disputedAt: disputedAt ? new Date(disputedAt) : null,
    disputeReason: row['dispute_reason'] as string | null,
  };
}

export function usePendingTransfers() {
  return useQuery({
    queryKey: bankTransferKeys.pendingList(),
    queryFn: async (): Promise<BankTransfer[]> => {
      const { data, error } = await supabase
        .from('bank_transfers')
        .select(TRANSFER_SELECT)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (error) {
        logger.error('usePendingTransfers: query failed', { error });
        throw error;
      }
      return (data as Record<string, unknown>[]).map(mapTransferRow);
    },
  });
}

export function useAllTransfers() {
  return useQuery({
    queryKey: bankTransferKeys.lists(),
    queryFn: async (): Promise<BankTransfer[]> => {
      const { data, error } = await supabase
        .from('bank_transfers')
        .select(TRANSFER_SELECT)
        .order('created_at', { ascending: true });
      if (error) {
        logger.error('useAllTransfers: query failed', { error });
        throw error;
      }
      return (data as Record<string, unknown>[]).map(mapTransferRow);
    },
  });
}

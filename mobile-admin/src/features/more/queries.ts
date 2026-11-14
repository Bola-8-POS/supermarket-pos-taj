/**
 * Queries + mutations for the "More" tab: bank transfers (the app's one write feature),
 * refunds, and the audit log. Every fetch: Supabase → throw on error → Zod parse.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { AuditLogSchema, BankTransferSchema, RefundSchema, type AuditLog } from '@/lib/schemas';
import { supabase } from '@/lib/supabase';

/** The untyped Supabase client (no Database generic) returns `any`; this pins the shape we rely on. */
type SupabaseResult = { data: unknown; error: { message: string } | null };

// ============================================================================
// Bank transfers
// ============================================================================

const TransferPaymentSchema = z.object({
  amount: z.number(),
  reference_number: z.string().nullable(),
  tab_id: z.string(),
  tabs: z.object({ customer_name: z.string().nullable(), staff_id: z.string() }).nullable(),
});

const TransferRowSchema = BankTransferSchema.extend({ payments: TransferPaymentSchema.nullable() });
export type TransferRow = z.infer<typeof TransferRowSchema>;

const TRANSFER_SELECT = '*, payments(amount,reference_number,tab_id, tabs(customer_name,staff_id))';

export function usePendingTransfers() {
  return useQuery({
    queryKey: ['transfers', 'pending'],
    queryFn: async (): Promise<TransferRow[]> => {
      const { data, error } = await supabase
        .from('bank_transfers')
        .select(TRANSFER_SELECT)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return z.array(TransferRowSchema).parse(data);
    },
  });
}

export function useTransferHistory(limit = 50) {
  return useQuery({
    queryKey: ['transfers', 'history', limit],
    queryFn: async (): Promise<TransferRow[]> => {
      const { data, error } = await supabase
        .from('bank_transfers')
        .select(TRANSFER_SELECT)
        .in('status', ['confirmed', 'disputed'])
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(TransferRowSchema).parse(data);
    },
  });
}

export function useTransfer(id: string) {
  return useQuery({
    queryKey: ['transfers', 'detail', id],
    enabled: !!id,
    queryFn: async (): Promise<TransferRow | null> => {
      const { data, error } = (await supabase
        .from('bank_transfers')
        .select(TRANSFER_SELECT)
        .eq('id', id)
        .maybeSingle()) as SupabaseResult;
      if (error) throw new Error(error.message);
      return data ? TransferRowSchema.parse(data) : null;
    },
  });
}

/** The two write RPCs return jsonb; a hard failure also arrives as a thrown Postgres error. */
type TransferRpcResult = { ok?: boolean; error?: string; message?: string } | null;

function rpcFailureMessage(data: unknown, fallback: string): string | null {
  const r = data as TransferRpcResult;
  if (r && r.ok === false) return r.error ?? r.message ?? fallback;
  return null;
}

export function useConfirmTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ paymentId, code }: { paymentId: string; code: string }) => {
      const { data, error } = (await supabase.rpc('confirm_transfer_payment', {
        p_payment_id: paymentId,
        p_entered_code: code,
      })) as SupabaseResult;
      if (error) throw new Error(error.message);
      const failure = rpcFailureMessage(data, 'Could not confirm the transfer.');
      if (failure) throw new Error(failure);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useDisputeTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ paymentId, reason }: { paymentId: string; reason: string }) => {
      const { data, error } = (await supabase.rpc('dispute_transfer_payment', {
        p_payment_id: paymentId,
        p_reason: reason,
      })) as SupabaseResult;
      if (error) throw new Error(error.message);
      const failure = rpcFailureMessage(data, 'Could not mark the transfer as disputed.');
      if (failure) throw new Error(failure);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

/** Age-based tone escalation for a pending transfer row — 'warning' past 30 minutes. */
export function transferAgeTone(createdAt: string): 'default' | 'warning' {
  return Date.now() - new Date(createdAt).getTime() > 30 * 60_000 ? 'warning' : 'default';
}

// ============================================================================
// Refunds
// ============================================================================

const RefundPaymentSchema = z.object({
  amount: z.number(),
  method: z.string(),
  tab_id: z.string(),
  tabs: z.object({ customer_name: z.string().nullable() }).nullable(),
});

const RefundRowSchema = RefundSchema.extend({ payments: RefundPaymentSchema.nullable() });
export type RefundRow = z.infer<typeof RefundRowSchema>;

export function useRefundsList(limit = 100) {
  return useQuery({
    queryKey: ['refunds', 'list', limit],
    queryFn: async (): Promise<RefundRow[]> => {
      const { data, error } = await supabase
        .from('refunds')
        .select('*, payments(amount,method,tab_id, tabs(customer_name))')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(RefundRowSchema).parse(data);
    },
  });
}

/** 30-day total/count, queried separately so it isn't capped by the 100-row list above. */
export function useRefunds30d() {
  return useQuery({
    queryKey: ['refunds', '30d'],
    queryFn: async (): Promise<{ total: number; count: number }> => {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data, error } = await supabase.from('refunds').select('amount').gte('created_at', since);
      if (error) throw new Error(error.message);
      const rows = z.array(z.object({ amount: z.number() })).parse(data);
      return { total: rows.reduce((sum, r) => sum + r.amount, 0), count: rows.length };
    },
  });
}

// ============================================================================
// Audit log
// ============================================================================

export function useAuditLogs(limit = 100) {
  return useQuery({
    queryKey: ['audit', 'list', limit],
    queryFn: async (): Promise<AuditLog[]> => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id,action,entity_type,entity_id,actor_id,created_at,source')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(AuditLogSchema).parse(data);
    },
  });
}

/** "payment.transfer_confirmed" → "Payment Transfer Confirmed". */
export function humaniseAction(action: string): string {
  return action
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

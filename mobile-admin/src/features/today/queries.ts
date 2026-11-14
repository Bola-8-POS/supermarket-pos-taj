import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';

import { startOfDay } from '@/lib/format';
import { BankTransferSchema, InventorySchema, PaymentSchema, TabSchema, type Payment } from '@/lib/schemas';
import { supabase } from '@/lib/supabase';

export type TodaySummary = {
  revenue: number;
  tickets: number;
  avgTicket: number;
  refunds: number;
  refundCount: number;
};

/** Pure aggregation, unit-tested. */
export function summarize(payments: Pick<Payment, 'amount' | 'is_refund' | 'tab_id' | 'status'>[]): TodaySummary {
  let revenue = 0;
  let refunds = 0;
  let refundCount = 0;
  const tabs = new Set<string>();
  for (const p of payments) {
    // Only settled money counts: 'pending'/'disputed' (bank transfers) and
    // 'reopened_void' (sale reopened/voided later) are excluded.
    if (p.status !== 'completed') continue;
    if (p.is_refund) {
      refunds += Math.abs(p.amount);
      refundCount += 1;
    } else {
      revenue += p.amount;
      tabs.add(p.tab_id);
    }
  }
  const tickets = tabs.size;
  return { revenue, tickets, avgTicket: tickets ? revenue / tickets : 0, refunds, refundCount };
}

export function useTodayPayments() {
  return useQuery({
    queryKey: ['today', 'payments'],
    queryFn: async () => {
      const from = startOfDay(new Date()).toISOString();
      const { data, error } = await supabase
        .from('payments')
        .select('id,tab_id,amount,method,status,is_refund,processed_at,processed_by,reference_number,discount_amount')
        .eq('is_deleted', false)
        .gte('processed_at', from)
        .order('processed_at', { ascending: false });
      if (error) throw new Error(error.message);
      return z.array(PaymentSchema).parse(data);
    },
  });
}

export function useRecentSales(limit = 5) {
  return useQuery({
    queryKey: ['today', 'recent-sales', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tabs')
        .select('id,status,staff_id,customer_name,opened_at,closed_at,caja_session_id,notes, payments(amount,method,is_refund,status)')
        // A completed direct sale leaves the tab 'closed' (legacy bar-era flows used 'paid').
        .in('status', ['closed', 'paid'])
        .eq('is_deleted', false)
        .order('closed_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      const Row = TabSchema.extend({
        payments: z.array(z.object({ amount: z.number(), method: z.string(), is_refund: z.boolean(), status: z.string() })),
      });
      return z.array(Row).parse(data).map(t => {
        const paid = t.payments.filter(p => !p.is_refund && p.status === 'completed');
        const total = paid.reduce((s, p) => s + p.amount, 0);
        const methods = [...new Set(paid.map(p => p.method))];
        return { ...t, total, methods };
      });
    },
  });
}

export function useAttentionCounts(nearExpiryDays: number) {
  return useQuery({
    queryKey: ['today', 'attention', nearExpiryDays],
    queryFn: async () => {
      const cutoff = new Date(Date.now() + nearExpiryDays * 86_400_000).toISOString().slice(0, 10);
      const [transfers, inv] = await Promise.all([
        supabase.from('bank_transfers').select('id,status').eq('status', 'pending'),
        supabase
          .from('inventory')
          .select('id,product_id,quantity_on_hand,low_stock_threshold,cost_price,expiry_date,unit, products!inner(id,name,barcode,sku,base_price,is_active,sold_by_weight,category_id)')
          .eq('products.is_active', true),
      ]);
      if (transfers.error) throw new Error(transfers.error.message);
      if (inv.error) throw new Error(inv.error.message);
      const rows = z.array(InventorySchema).parse(inv.data);
      const lowStock = rows.filter(r => r.quantity_on_hand <= r.low_stock_threshold).length;
      const nearExpiry = rows.filter(r => r.expiry_date && r.expiry_date <= cutoff && r.quantity_on_hand > 0).length;
      return {
        pendingTransfers: z.array(BankTransferSchema.pick({ id: true, status: true })).parse(transfers.data).length,
        lowStock,
        nearExpiry,
      };
    },
  });
}

/** One Realtime channel: a new payment invalidates today's numbers. */
export function useTodayRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    const ch = supabase
      .channel('admin-today')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => {
        void qc.invalidateQueries({ queryKey: ['today'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'caja_sessions' }, () => {
        void qc.invalidateQueries({ queryKey: ['caja'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        void qc.invalidateQueries({ queryKey: ['shifts'] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [qc]);
}

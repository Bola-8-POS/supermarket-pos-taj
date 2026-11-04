/**
 * Team tab + staff detail + caja (register) session queries.
 * Every fetch: Supabase query → throw on error → Zod parse. Pure aggregation helpers are
 * exported separately so they're unit-testable (mirrors src/features/sales/queries.ts).
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import {
  CajaEntrySchema,
  CajaSessionSchema,
  RoleSchema,
  ShiftSchema,
  type CajaEntry,
  type CajaSession,
  type Role,
  type Shift,
} from '@/lib/schemas';
import { supabase } from '@/lib/supabase';

export type DateRange = { from: Date; to: Date };

// ---- Pure helpers ----

const ROLE_ORDER: Role[] = ['admin', 'manager', 'cashier', 'kitchen'];

/** Sort weight for the Staff list — admin, manager, cashier, then kitchen. */
export function roleRank(role: Role): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

/**
 * Total hours worked across shifts that overlap [from, to]. An open shift (no clock_out)
 * counts through `now`. Shifts outside the range contribute nothing.
 */
export function hoursWorked(shifts: Pick<Shift, 'clock_in' | 'clock_out'>[], from: Date, to: Date, now = new Date()): number {
  let ms = 0;
  for (const s of shifts) {
    const start = new Date(s.clock_in);
    const end = s.clock_out ? new Date(s.clock_out) : now;
    const clippedStart = start < from ? from : start;
    const clippedEnd = end > to ? to : end;
    if (clippedEnd > clippedStart) ms += clippedEnd.getTime() - clippedStart.getTime();
  }
  return ms / 3_600_000;
}

export function expectedCash(opts: {
  openingCash: number;
  cashSales: number;
  cashRefunds: number;
  entriesIn: number;
  entriesOut: number;
}): number {
  return opts.openingCash + opts.cashSales - opts.cashRefunds + opts.entriesIn - opts.entriesOut;
}

/** Non-refund, non-pending/disputed cash payments vs. cash refunds for a caja session. */
export function summarizeCashFlow(rows: { amount: number; is_refund: boolean; status: string; method: string }[]): {
  cashSales: number;
  cashRefunds: number;
} {
  let cashSales = 0;
  let cashRefunds = 0;
  for (const r of rows) {
    if (r.method !== 'cash' || r.status !== 'completed') continue;
    if (r.is_refund) cashRefunds += Math.abs(r.amount);
    else cashSales += r.amount;
  }
  return { cashSales, cashRefunds };
}

// ponytail: caja_entries.type is only confirmed to carry 'income'/'expense' upstream. Anything
// else is treated as inbound for the cash-diff math (it only affects the computed diff — the
// raw type string is still shown as-is in the entries list). Add a real enum if new types land.
export function summarizeEntries(entries: Pick<CajaEntry, 'type' | 'amount'>[]): { entriesIn: number; entriesOut: number } {
  let entriesIn = 0;
  let entriesOut = 0;
  for (const e of entries) {
    if (e.type === 'expense') entriesOut += e.amount;
    else entriesIn += e.amount;
  }
  return { entriesIn, entriesOut };
}

/** Non-refund, non-pending/disputed payments attributed to a staff member's tabs. */
export function summarizeStaffSales(rows: { tab_id: string; amount: number; is_refund: boolean; status: string }[]): {
  sales: number;
  tickets: number;
} {
  let sales = 0;
  const tabs = new Set<string>();
  for (const r of rows) {
    if (r.is_refund || r.status !== 'completed') continue;
    sales += r.amount;
    tabs.add(r.tab_id);
  }
  return { sales, tickets: tabs.size };
}

// ---- Staff detail ----

const StaffPaymentRowSchema = z.object({
  tab_id: z.string(),
  amount: z.number(),
  is_refund: z.boolean(),
  status: z.string(),
  processed_at: z.string(),
  tabs: z.object({ staff_id: z.string() }),
});

/** Sales attributed to a staff member (via their tabs) within a date range. */
export function useStaffSales(staffId: string, range: DateRange) {
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  return useQuery({
    queryKey: ['team', 'staff-sales', staffId, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payments')
        .select('tab_id,amount,is_refund,status,processed_at, tabs!inner(staff_id,is_deleted)')
        .eq('is_deleted', false)
        .eq('tabs.staff_id', staffId)
        .eq('tabs.is_deleted', false)
        .gte('processed_at', fromIso)
        .lte('processed_at', toIso);
      if (error) throw new Error(error.message);
      return summarizeStaffSales(z.array(StaffPaymentRowSchema).parse(data));
    },
  });
}

/**
 * Recent shifts for one staff member, newest first. Used both for the "Shifts" list (first 30)
 * and — via hoursWorked() — for the hours-worked KPI over the selected range.
 */
export function useStaffShifts(staffId: string, limit = 200) {
  return useQuery({
    queryKey: ['team', 'staff-shifts', staffId, limit],
    queryFn: async (): Promise<Shift[]> => {
      const { data, error } = await supabase
        .from('shifts')
        .select('id,staff_id,clock_in,clock_out,opening_cash,closing_cash')
        .eq('staff_id', staffId)
        .order('clock_in', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(ShiftSchema).parse(data);
    },
  });
}

export function useStaffProfile(staffId: string) {
  return useQuery({
    queryKey: ['team', 'staff-profile', staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,name,role,is_active,locale')
        .eq('id', staffId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return z.object({ id: z.string(), name: z.string(), role: RoleSchema, is_active: z.boolean(), locale: z.string() }).parse(data);
    },
  });
}

// ---- Caja (register) sessions ----

const CAJA_COLUMNS = 'id,status,opened_at,opened_by,closed_at,closed_by,opening_cash,closing_cash,notes';

export function useLastClosedCaja() {
  return useQuery({
    queryKey: ['caja', 'last-closed'],
    queryFn: async (): Promise<CajaSession | null> => {
      const { data, error } = await supabase
        .from('caja_sessions')
        .select(CAJA_COLUMNS)
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? CajaSessionSchema.parse(data) : null;
    },
  });
}

export function useClosedCajaSessions(limit = 30) {
  return useQuery({
    queryKey: ['caja', 'closed', limit],
    queryFn: async (): Promise<CajaSession[]> => {
      const { data, error } = await supabase
        .from('caja_sessions')
        .select(CAJA_COLUMNS)
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return z.array(CajaSessionSchema).parse(data);
    },
  });
}

export function useCajaSessionDetail(id: string) {
  return useQuery({
    queryKey: ['caja', 'session', id],
    enabled: !!id,
    queryFn: async (): Promise<CajaSession | null> => {
      const { data, error } = await supabase.from('caja_sessions').select(CAJA_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? CajaSessionSchema.parse(data) : null;
    },
  });
}

const CajaPaymentRowSchema = z.object({
  amount: z.number(),
  is_refund: z.boolean(),
  status: z.string(),
  method: z.string(),
  tabs: z.object({ caja_session_id: z.string().nullable() }),
});

/** Cash sales/refunds for one caja session, via its tabs. */
export function useCajaCashFlow(sessionId: string | null) {
  return useQuery({
    queryKey: ['caja', 'cash-flow', sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payments')
        .select('amount,is_refund,status,method, tabs!inner(caja_session_id,is_deleted)')
        .eq('is_deleted', false)
        .eq('tabs.caja_session_id', sessionId as string)
        .eq('tabs.is_deleted', false);
      if (error) throw new Error(error.message);
      return summarizeCashFlow(z.array(CajaPaymentRowSchema).parse(data));
    },
  });
}

export function useCajaEntries(sessionId: string | null) {
  return useQuery({
    queryKey: ['caja', 'entries', sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<CajaEntry[]> => {
      const { data, error } = await supabase
        .from('caja_entries')
        .select('id,caja_session_id,amount,concept,type,staff_id,created_at')
        .eq('caja_session_id', sessionId as string)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return z.array(CajaEntrySchema).parse(data);
    },
  });
}

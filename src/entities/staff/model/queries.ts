import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Shift, Staff, StaffMetric } from '@shared/lib/domain';
import { LocaleSchema, StaffMetricSchema } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type AppErrorCode,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Tables } from '@shared/lib/supabase.types';
import { getTerminalId } from '@shared/lib/terminal';
import { useStaffStore } from './store';
import { ShiftSchema, StaffSchema } from './types';

/* eslint-disable i18next/no-literal-string -- query-key namespace strings +
   unknownError(...) internal debug codes + multi-line Supabase chain args
   below are not UI copy (plugin doesn't resolve excluded callees across a
   multi-line method chain — 21-08 quirk). */
export const staffKeys = {
  all: ['staff'] as const,
  list: () => [...staffKeys.all, 'list'] as const,
  openShifts: () => [...staffKeys.all, 'openShifts'] as const,
  shiftClosePreview: (shiftId: string, staffId: string) =>
    [...staffKeys.all, 'shiftClosePreview', shiftId, staffId] as const,
  staffMetrics: (from: string, to: string) => [...staffKeys.all, 'staffMetrics', from, to] as const,
};

/** Row shape of the `staff_directory` view (not in the generated types yet). */
export interface StaffDirectoryRow {
  id: string;
  name: string;
  role: Tables<'profiles'>['role'];
  is_active: boolean;
  must_change_pin: boolean;
  locale: string;
}

export function mapStaffRow(row: StaffDirectoryRow): Result<Staff> {
  try {
    return ok(
      StaffSchema.parse({
        id: row.id,
        name: row.name,
        role: row.role,
        isActive: row.is_active,
        mustChangePin: row.must_change_pin,
        locale: row.locale,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

function mapShiftRow(row: Tables<'shifts'>): Result<Shift> {
  try {
    return ok(
      ShiftSchema.parse({
        id: row.id,
        staffId: row.staff_id,
        clockIn: new Date(row.clock_in),
        clockOut: row.clock_out ? new Date(row.clock_out) : null,
        openingCash: row.opening_cash,
        closingCash: row.closing_cash,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

/** Active staff profiles; syncs {@link useStaffStore} `staffList` on success. */
export function useStaffList() {
  const setStaffList = useStaffStore(s => s.setStaffList);

  const query = useQuery({
    queryKey: staffKeys.list(),
    queryFn: async (): Promise<Result<Staff[]>> => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
         staff_directory is not in the generated types yet (repo-wide cast pattern). */
      const res = await supabaseQuery<StaffDirectoryRow[]>(() =>
        (supabase as any)
          .from('staff_directory')
          .select('id, name, role, is_active, must_change_pin, locale')
          .order('name')
      );
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

      if (!res.ok) {
        logger.error('staff.list.fetch_failed', { message: res.error.message });
        return res;
      }

      const staff: Staff[] = [];
      for (const row of res.data) {
        const m = mapStaffRow(row);
        if (!m.ok) {
          logger.error('staff.list.map_failed', { message: m.error.message });
          return m;
        }
        staff.push(m.data);
      }
      return ok(staff);
    },
  });

  useEffect(() => {
    if (query.data?.ok) {
      setStaffList(query.data.data);
    }
  }, [query.data, setStaffList]);

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

/** Open shifts (no clock-out); used on staff dashboard. */
export function useOpenShifts() {
  const query = useQuery({
    queryKey: staffKeys.openShifts(),
    queryFn: async (): Promise<Result<Shift[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('shifts')
          .select('*')
          .is('clock_out', null)
          .order('clock_in', { ascending: false })
      );

      if (!res.ok) {
        logger.error('staff.open_shifts.fetch_failed', { message: res.error.message });
        return res;
      }

      const shifts: Shift[] = [];
      for (const row of res.data) {
        const m = mapShiftRow(row);
        if (!m.ok) {
          logger.error('staff.open_shifts.map_failed', { message: m.error.message });
          return m;
        }
        shifts.push(m.data);
      }
      return ok(shifts);
    },
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

export type ShiftClosePreview = {
  /** Non-voided orders this staff placed on tabs in this shift. */
  orderCount: number;
  /** Sum of payment amounts this staff processed for tabs in this shift. */
  totalSales: number;
  shiftStartedAt: Date;
};

/**
 * Aggregates shift-close summary for the clock-out dialog.
 * Orders: `orders` joined to `tabs` with this `shift_id`, `staff_id` = staff, status ≠ voided.
 * Sales: `payments` for tabs in the shift where `processed_by` = staff (tab-closure payments).
 */
export function useShiftClosePreview(shiftId: string | null, staffId: string | null) {
  const query = useQuery({
    queryKey:
      shiftId && staffId
        ? staffKeys.shiftClosePreview(shiftId, staffId)
        : ['staff', 'shiftClosePreview', 'idle'],
    enabled: Boolean(shiftId && staffId),
    queryFn: async (): Promise<Result<ShiftClosePreview>> => {
      if (!shiftId || !staffId) {
        return err(unknownError('missing_shift_or_staff'));
      }

      const tabsRes = await supabaseQuery(() =>
        supabase.from('tabs').select('id').eq('shift_id', shiftId)
      );
      if (!tabsRes.ok) {
        logger.error('staff.shift_preview.tabs_failed', { message: tabsRes.error.message });
        return tabsRes;
      }
      const tabIds = tabsRes.data.map(t => t.id);
      if (tabIds.length === 0) {
        const shiftRes = await supabaseQuery<{ clock_in: string }>(() =>
          supabase.from('shifts').select('clock_in').eq('id', shiftId).single()
        );
        if (!shiftRes.ok) return shiftRes as Result<ShiftClosePreview>;
        const started = new Date(shiftRes.data.clock_in);
        return ok({ orderCount: 0, totalSales: 0, shiftStartedAt: started });
      }

      const [ordersRes, paymentsRes, shiftRes] = await Promise.all([
        supabaseQuery(() =>
          supabase
            .from('orders')
            .select('id')
            .in('tab_id', tabIds)
            .eq('staff_id', staffId)
            .neq('status', 'voided')
        ),
        supabaseQuery(() =>
          supabase
            .from('payments')
            .select('amount')
            .in('tab_id', tabIds)
            .eq('processed_by', staffId)
            .eq('is_deleted', false)
            // Mirrors get_caja_report's `status IS DISTINCT FROM 'reopened_void'`:
            // an `.or()` (not `.neq()`) so a null `status` (pre-status rows) is
            // still counted, not silently dropped by PostgREST.
            .or('status.is.null,status.neq.reopened_void')
        ),
        supabaseQuery<{ clock_in: string }>(() =>
          supabase.from('shifts').select('clock_in').eq('id', shiftId).single()
        ),
      ]);

      if (!ordersRes.ok) {
        return ordersRes as Result<ShiftClosePreview>;
      }
      if (!paymentsRes.ok) {
        return paymentsRes as Result<ShiftClosePreview>;
      }
      if (!shiftRes.ok) {
        return shiftRes as Result<ShiftClosePreview>;
      }

      const orderCount = ordersRes.data.length;
      const totalSales = paymentsRes.data.reduce((sum, row) => sum + row.amount, 0);
      const shiftStartedAt = new Date(shiftRes.data.clock_in);

      return ok({ orderCount, totalSales, shiftStartedAt });
    },
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

function shouldApplyShiftToStore(staffId: string): boolean {
  const selfId = useStaffStore.getState().currentStaff?.id;
  return selfId != null && selfId === staffId;
}

type ClockInContext = {
  previousShift: Shift | null | undefined;
  appliedOptimistic: boolean;
};

export function useMutationClockIn() {
  const queryClient = useQueryClient();

  return useMutation<
    Result<Shift>,
    Error,
    { staffId: string; openingCash: number },
    ClockInContext
  >({
    mutationFn: async ({
      staffId,
      openingCash,
    }: {
      staffId: string;
      openingCash: number;
    }): Promise<Result<Shift>> => {
      const res = await supabaseMutation(() =>
        supabase
          .from('shifts')
          .insert({
            staff_id: staffId,
            opening_cash: openingCash,
          })
          .select()
          .single()
      );

      if (!res.ok) {
        logger.error('staff.clock_in.insert_failed', { message: res.error.message });
        return res;
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrow for mapShiftRow
      if (res.data == null) {
        return err(unknownError('no_row'));
      }

      return mapShiftRow(res.data);
    },

    onMutate: ({ staffId, openingCash }): ClockInContext => {
      const previousShift = useStaffStore.getState().currentShift;
      if (!shouldApplyShiftToStore(staffId)) {
        return { previousShift, appliedOptimistic: false };
      }
      const tempId = crypto.randomUUID();
      const optimistic = ShiftSchema.parse({
        id: tempId,
        staffId,
        clockIn: new Date(),
        clockOut: null,
        openingCash,
        closingCash: null,
      });
      useStaffStore.getState().updateShift(optimistic);
      return { previousShift, appliedOptimistic: true };
    },

    onSuccess: (result, _vars, ctx) => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.openShifts() });
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });

      if (!result.ok) {
        logger.error('staff.clock_in.failed', { message: result.error.message });
        // TanStack may omit context on edge failures; keep guard for runtime safety.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ctx != null && ctx.appliedOptimistic) {
          if (ctx.previousShift) {
            useStaffStore.getState().updateShift(ctx.previousShift);
          } else {
            useStaffStore.setState({ currentShift: null });
          }
        }
        return;
      }
      if (shouldApplyShiftToStore(result.data.staffId)) {
        useStaffStore.getState().updateShift(result.data);
      }
    },

    onError: (_e, _v, ctx) => {
      if (ctx == null) return;
      if (ctx.appliedOptimistic) {
        if (ctx.previousShift) {
          useStaffStore.getState().updateShift(ctx.previousShift);
        } else {
          useStaffStore.setState({ currentShift: null });
        }
      }
    },
  });
}

type ClockOutContext = {
  previousShift: Shift | null | undefined;
  appliedOptimistic: boolean;
};

export function useMutationClockOut() {
  const queryClient = useQueryClient();

  return useMutation<
    Result<Shift>,
    Error,
    { shiftId: string; staffId: string; closingCash: number },
    ClockOutContext
  >({
    mutationFn: async ({
      shiftId,
      staffId,
      closingCash,
    }: {
      shiftId: string;
      /** Shift owner — used so we do not overwrite another user’s `currentShift` in the store. */
      staffId: string;
      closingCash: number;
    }): Promise<Result<Shift>> => {
      const res = await supabaseMutation(() =>
        supabase
          .from('shifts')
          .update({
            clock_out: new Date().toISOString(),
            closing_cash: closingCash,
          })
          .eq('id', shiftId)
          .eq('staff_id', staffId)
          .select()
          .single()
      );

      if (!res.ok) {
        logger.error('staff.clock_out.update_failed', { message: res.error.message });
        return res;
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrow for mapShiftRow
      if (res.data == null) {
        return err(unknownError('no_row'));
      }

      return mapShiftRow(res.data);
    },

    onMutate: ({ shiftId, staffId, closingCash }): ClockOutContext => {
      const previousShift = useStaffStore.getState().currentShift;
      const cur = previousShift;
      const apply = Boolean(
        cur && cur.id === shiftId && shouldApplyShiftToStore(staffId) && cur.staffId === staffId
      );
      if (apply && cur) {
        useStaffStore.getState().updateShift({
          ...cur,
          clockOut: new Date(),
          closingCash,
        });
        return { previousShift, appliedOptimistic: true };
      }
      return { previousShift, appliedOptimistic: false };
    },

    onSuccess: (result, vars, ctx) => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.openShifts() });
      void queryClient.invalidateQueries({
        queryKey: staffKeys.shiftClosePreview(vars.shiftId, vars.staffId),
      });
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });

      if (!result.ok) {
        logger.error('staff.clock_out.failed', { message: result.error.message });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ctx != null && ctx.appliedOptimistic && ctx.previousShift) {
          useStaffStore.getState().updateShift(ctx.previousShift);
        }
        return;
      }
      if (shouldApplyShiftToStore(result.data.staffId)) {
        useStaffStore.getState().updateShift(result.data);
      }
    },

    onError: (_e, _v, ctx) => {
      if (ctx == null) return;
      if (ctx.appliedOptimistic && ctx.previousShift) {
        useStaffStore.getState().updateShift(ctx.previousShift);
      }
    },
  });
}

export function useMutationUpdateStaffRole() {
  const queryClient = useQueryClient();

  return useMutation<Result<Staff>, Error, { staffId: string; role: Staff['role'] }>({
    mutationFn: async ({ staffId, role }): Promise<Result<Staff>> => {
      const res = await supabaseMutation(() =>
        supabase.from('profiles').update({ role }).eq('id', staffId).select('id, name, role, is_active, must_change_pin, locale').single()
      );

      if (!res.ok) {
        logger.error('staff.update_role.failed', { message: res.error.message });
        return res;
      }

      // res.data is guaranteed to be the single updated profile row
      const m = mapStaffRow(res.data as unknown as Tables<'profiles'>);
      if (!m.ok) {
        logger.error('staff.update_role.map_failed', { message: m.error.message });
        return m;
      }

      // p_terminal_id/p_user_id not yet in generated supabase.types.ts (14-02 gap) — cast as never like OfflineQueueProcessor's record_audit call.
      const auditRes = await supabase.rpc('record_audit', {
        p_action: 'staff.role_change',
        p_entity_type: 'staff',
        p_entity_id: staffId,
        p_before: null,
        p_after: { role },
        p_source: 'client',
        p_terminal_id: getTerminalId(),
        p_user_id: null,
      } as never);
      if (auditRes.error) {
        logger.warn('staff.role_change.audit_failed', {
          staffId,
          message: auditRes.error.message,
        });
      }

      return m;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
    },
  });
}

/**
 * Self-service locale change (used by 21-03's Settings "Language" tab).
 * Calls the `set_own_locale` SECURITY DEFINER RPC, which is scoped to
 * `auth.uid()`'s own row only — no staffId param, works for ANY authenticated
 * role including cashier (bypasses the manage_staff-only
 * `profiles_update_admin` RLS safely). Audited server-side by the RPC itself.
 */
export function useMutationSetOwnLocale() {
  const queryClient = useQueryClient();

  return useMutation<Result<null>, Error, { locale: Staff['locale'] }>({
    mutationFn: async ({ locale }): Promise<Result<null>> => {
      const parsed = LocaleSchema.safeParse(locale);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR' as AppErrorCode,
          // eslint-disable-next-line i18next/no-literal-string -- real UI-facing
          // error message, must stay translated despite the file's technical-noise disable above.
          message: i18n.t('entities:staff.unsupportedLocale'),
        });
      }

      const res = await supabaseMutation(() =>
        supabase.rpc('set_own_locale', { p_locale: parsed.data, p_terminal_id: getTerminalId() })
      );

      if (!res.ok) {
        logger.error('staff.set_own_locale.failed', { message: res.error.message });
        return res;
      }

      return ok(null);
    },
    onSuccess: (_result, { locale }) => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
      // CR-01: keep the persisted currentStaff.locale in sync — otherwise
      // onRehydrateStorage re-applies the stale locale on next app reload.
      const current = useStaffStore.getState().currentStaff;
      if (current) {
        useStaffStore.setState({ currentStaff: { ...current, locale } });
      }
    },
  });
}

/**
 * Admin-set locale for a target staff member (used by 21-04's Staff
 * management page). Direct UPDATE gated server-side by the EXISTING
 * `manage_staff` `profiles_update_admin` RLS policy — a non-manage_staff
 * caller is RLS-filtered to 0 rows (see V4/T-21-02 integration test). No new
 * write path is introduced.
 */
export function useMutationUpdateStaffLocale() {
  const queryClient = useQueryClient();

  return useMutation<Result<Staff>, Error, { staffId: string; locale: Staff['locale'] }>({
    mutationFn: async ({ staffId, locale }): Promise<Result<Staff>> => {
      const res = await supabaseMutation(() =>
        supabase.from('profiles').update({ locale }).eq('id', staffId).select('id, name, role, is_active, must_change_pin, locale').single()
      );

      if (!res.ok) {
        logger.error('staff.update_locale.failed', { message: res.error.message });
        return res;
      }

      const m = mapStaffRow(res.data as unknown as Tables<'profiles'>);
      if (!m.ok) {
        logger.error('staff.update_locale.map_failed', { message: m.error.message });
        return m;
      }

      const auditRes = await supabase.rpc('record_audit', {
        p_action: 'staff.locale_change',
        p_entity_type: 'staff',
        p_entity_id: staffId,
        p_before: null,
        p_after: { locale },
        p_source: 'client',
        p_terminal_id: getTerminalId(),
      });
      if (auditRes.error) {
        logger.warn('staff.locale_change.audit_failed', {
          staffId,
          message: auditRes.error.message,
        });
      }

      return m;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.list() });
    },
  });
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// db is typed as any because order_items/payments columns may not be in supabase.types.ts yet.
// Regenerate types and remove this cast when the generated types are up to date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ProfileRow = { id: string; name: string };
type OrderItemRow = {
  quantity: number;
  unit_price: number;
  orders: { staff_id: string | null; status: string; tab_id: string } | null;
};

async function fetchActiveProfiles(): Promise<{
  data: ProfileRow[] | null;
  error: { message: string } | null;
}> {
  return db.from('profiles').select('id, name').eq('is_active', true) as Promise<{
    data: ProfileRow[] | null;
    error: { message: string } | null;
  }>;
}

async function fetchOrderItemsInRange(
  from: Date,
  to: Date
): Promise<{ data: OrderItemRow[] | null; error: { message: string } | null }> {
  return db
    .from('order_items')
    .select('quantity, unit_price, orders!inner(staff_id, status, tab_id)')
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString()) as Promise<{
    data: OrderItemRow[] | null;
    error: { message: string } | null;
  }>;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

export function useStaffMetrics(from: Date, to: Date): UseQueryResult<Result<StaffMetric[]>> {
  return useQuery({
    queryKey: staffKeys.staffMetrics(from.toISOString(), to.toISOString()),
    queryFn: async (): Promise<Result<StaffMetric[]>> => {
      const { data: profiles, error: profilesError } = await fetchActiveProfiles();

      if (profilesError) {
        return err({ code: 'SUPABASE_ERROR' as AppErrorCode, message: profilesError.message });
      }

      const { data: items, error: itemsError } = await fetchOrderItemsInRange(from, to);

      if (itemsError) {
        return err({ code: 'SUPABASE_ERROR' as AppErrorCode, message: itemsError.message });
      }

      const metricsMap = new Map<
        string,
        { name: string; revenue: number; tabIds: Set<string>; voidCount: number }
      >();

      for (const profile of profiles ?? []) {
        metricsMap.set(profile.id, {
          name: profile.name,
          revenue: 0,
          tabIds: new Set(),
          voidCount: 0,
        });
      }

      for (const item of items ?? []) {
        const createdBy = item.orders?.staff_id ?? null;
        if (!createdBy) continue;
        const entry = metricsMap.get(createdBy);
        if (!entry) continue;
        if (item.orders?.status === 'voided') {
          entry.voidCount += 1;
        } else {
          entry.revenue += item.unit_price * item.quantity;
          entry.tabIds.add(item.orders?.tab_id ?? '');
        }
      }

      const metrics: StaffMetric[] = [];
      for (const [staffId, entry] of metricsMap.entries()) {
        const transactionCount = entry.tabIds.size;
        const avgCheckSize = transactionCount > 0 ? entry.revenue / transactionCount : 0;
        metrics.push(
          StaffMetricSchema.parse({
            staffId,
            staffName: entry.name,
            revenue: entry.revenue,
            transactionCount,
            avgCheckSize,
            voidCount: entry.voidCount,
          })
        );
      }

      metrics.sort((a, b) => b.revenue - a.revenue);
      return ok(metrics);
    },
    staleTime: 30_000,
  });
}

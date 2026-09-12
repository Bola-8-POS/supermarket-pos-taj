/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, i18next/no-literal-string */
// i18next/no-literal-string: query-key namespace strings + multi-line Supabase
// chain args below are wire-protocol identifiers, not UI copy (plugin doesn't
// resolve excluded callees across a multi-line method chain — 21-08 quirk).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { CajaEntry, CajaEntryCreate, CajaReport, CajaSession, PaymentMethod } from '@shared/lib/domain';
import {
  CajaEntrySchema,
  CajaReportSchema,
  CajaSessionSchema,
  PAYMENT_METHODS,
  PaymentMethodSchema,
} from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import {
  ok,
  err,
  staleVersionError,
  supabaseQuery,
  supabaseMutation,
  unknownError,
  type AppError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { handleVersionError } from '@shared/lib/version-error';
import { useCajaStore } from './store';

const TERMINAL_ID =
  (import.meta.env.VITE_TERMINAL_ID as string | undefined) ?? 'POS-1';

const db = supabase as any;

const cajaKeys = {
  all: ['caja'] as const,
  current: () => [...cajaKeys.all, 'current'] as const,
  list: () => [...cajaKeys.all, 'list'] as const,
  report: (cajaId: string) => [...cajaKeys.all, 'report', cajaId] as const,
};

function mapCajaRow(row: Record<string, unknown>): Result<CajaSession> {
  try {
    return ok(
      CajaSessionSchema.parse({
        id: row.id,
        openedAt: new Date(row.opened_at as string),
        closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
        openedBy: row.opened_by,
        closedBy: row.closed_by ?? null,
        openingCash: row.opening_cash,
        closingCash: row.closing_cash ?? null,
        notes: row.notes ?? null,
        status: row.status,
        openedByName: row.opened_by_name as string | undefined,
        closedByName: row.closed_by_name as string | null | undefined,
        // Phase 15: optimistic-concurrency version (column added 20260512000001)
        ...(typeof row.version === 'number' ? { version: row.version } : {}),
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

/** Fetches the currently open caja session; syncs useCajaStore. */
export function useCurrentCaja() {
  const setCaja = useCajaStore(s => s.setCaja);

  const query = useQuery({
    queryKey: cajaKeys.current(),
    queryFn: async (): Promise<Result<CajaSession | null>> => {
      const res = await supabaseQuery(() =>
        db
          .from('caja_sessions')
          .select(
            '*, opened_by_profile:profiles!opened_by(name), closed_by_profile:profiles!closed_by(name)'
          )
          .eq('status', 'open')
          .limit(1)
          .maybeSingle()
      );

      if (!res.ok) {
        logger.error('caja.current.fetch_failed', { message: res.error.message });
        return res as Result<null>;
      }

      if (!res.data) return ok(null);

      // Flatten profile join
      const raw = res.data as Record<string, unknown>;
      const row = {
        ...raw,
        opened_by_name: (raw.opened_by_profile as { name?: string } | null)?.name,
        closed_by_name: (raw.closed_by_profile as { name?: string } | null)?.name ?? null,
      };

      return mapCajaRow(row);
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.data?.ok) {
      setCaja(query.data.data);
    }
  }, [query.data, setCaja]);

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
  };
}

/** Fetches list of all caja sessions for the reports page date picker. */
export function useCajaList() {
  return useQuery({
    queryKey: cajaKeys.list(),
    queryFn: async (): Promise<Result<CajaSession[]>> => {
      const res = await supabaseQuery(() =>
        db
          .from('caja_sessions')
          .select(
            '*, opened_by_profile:profiles!opened_by(name), closed_by_profile:profiles!closed_by(name)'
          )
          .order('opened_at', { ascending: false })
          .limit(90)
      );

      if (!res.ok) return res;

      const sessions: CajaSession[] = [];
      for (const row of res.data as Record<string, unknown>[]) {
        const flat = {
          ...row,
          opened_by_name: (row.opened_by_profile as { name?: string } | null)?.name,
          closed_by_name: (row.closed_by_profile as { name?: string } | null)?.name ?? null,
        };
        const m = mapCajaRow(flat);
        if (!m.ok) return m;
        sessions.push(m.data);
      }
      return ok(sessions);
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// OPEN CAJA
// ============================================================================

export function useMutationOpenCaja() {
  const queryClient = useQueryClient();
  const setCaja = useCajaStore(s => s.setCaja);

  return useMutation<Result<CajaSession>, Error, { openingCash: number; openedBy: string }>({
    mutationFn: async ({ openingCash, openedBy }) => {
      const res = await supabaseMutation(() =>
        db.rpc('caja_open', {
          p_opening_cash: openingCash,
          p_opened_by: openedBy,
          p_terminal_id: TERMINAL_ID,
        })
      );

      if (!res.ok) {
        logger.error('caja.open.failed', { message: res.error.message });
        return res;
      }

      if (res.data == null) return err(unknownError('no_row'));

      return mapCajaRow(res.data as Record<string, unknown>);
    },

    onSuccess: result => {
      if (!result.ok) return;
      setCaja(result.data);
      void queryClient.invalidateQueries({ queryKey: cajaKeys.all });
      logger.info('caja.opened', { cajaId: result.data.id });
    },
  });
}

// ============================================================================
// CLOSE CAJA — hard block enforced in DB via close_caja_session RPC
// ============================================================================

type CloseCajaInput = {
  cajaId: string;
  closedBy: string;
  closingCash: number;
  notes: string | undefined;
};

type CloseCajaRpcResult = {
  ok: boolean;
  error?: { code: string; message: string; openTabCount?: number };
};

export function useMutationCloseCaja() {
  const queryClient = useQueryClient();
  const clearCaja = useCajaStore(s => s.clearCaja);

  return useMutation<Result<undefined>, Error, CloseCajaInput>({
    mutationFn: async ({ cajaId, closedBy, closingCash, notes }) => {
      // Phase 15 Group B: pre-RPC version-guard via direct UPDATE.
      // The close_caja_session RPC owns the actual close transition; we use a
      // best-effort optimistic-concurrency probe on caja_sessions.version to
      // detect concurrent edits BEFORE invoking the RPC. If the row has been
      // touched by another terminal (.eq('version', expected) returns 0 rows),
      // surface STALE_VERSION via handleVersionError.
      const cached = queryClient.getQueryData<Result<CajaSession | null>>(cajaKeys.current());
      const expected =
        cached?.ok && cached.data && typeof cached.data.version === 'number'
          ? cached.data.version
          : undefined;
      if (expected !== undefined) {
        // Touch updated_at while asserting version. Trigger bumps version → expected+2.
        const { data: probe, error: probeErr } = await db
          .from('caja_sessions')
          .update({ notes: notes ?? null, version: expected + 1 })
          .eq('id', cajaId)
          .eq('version', expected)
          .select('id')
          .maybeSingle();
        if (probeErr?.code === 'PGRST116' || (!probe && !probeErr)) {
          return err(staleVersionError(probeErr));
        }
        if (probeErr) {
          logger.warn('caja.close.version_probe_failed', { message: probeErr.message as string });
          // Fall through to RPC — non-fatal
        }
      }

      const { data, error } = await db.rpc('close_caja_session', {
        p_caja_id: cajaId,
        p_closed_by: closedBy,
        p_closing_cash: closingCash,
        p_notes: notes ?? null,
      });

      if (error) {
        logger.error('caja.close.rpc_error', { message: error.message });
        return err(unknownError(error));
      }

      const result = data as CloseCajaRpcResult;
      if (!result.ok) {
        const e = result.error;
        const appErr: AppError = {
          code: (e?.code ?? 'UNKNOWN_ERROR') as AppError['code'],
          message: e?.message ?? i18n.t('entities:caja.closeFailed'),
        };
        logger.warn('caja.close.blocked', { code: appErr.code });
        return err(appErr);
      }

      return ok(undefined);
    },

    onSuccess: (result, variables) => {
      if (!result.ok) {
        // Phase 15: surface STALE_VERSION conflict
        const cached = queryClient.getQueryData<Result<CajaSession | null>>(cajaKeys.current());
        const expectedVersion =
          cached?.ok && cached.data && typeof cached.data.version === 'number'
            ? cached.data.version
            : 0;
        handleVersionError(result.error, {
          queryClient,
          queryKey: cajaKeys.all,
          entity: 'caja_sessions',
          entityId: variables.cajaId,
          expectedVersion,
          supabase,
          terminalId: TERMINAL_ID,
        });
        return;
      }
      clearCaja();
      void queryClient.invalidateQueries({ queryKey: cajaKeys.all });
      logger.info('caja.closed');
    },
  });
}

// ============================================================================
// CAJA PAYMENT SUMMARY
// ============================================================================

export type CajaPaymentSummary = Record<PaymentMethod, number>;

/**
 * Queries payments for the current caja session, grouped by method.
 * Uses tabs.caja_session_id to scope payments to the session.
 */
export function useCajaPaymentSummary(cajaSession: { id: string; openedAt: Date } | null) {
  const cajaId = cajaSession?.id ?? null;

  return useQuery({
    queryKey: ['caja', 'payment-summary', cajaId] as const,
    enabled: cajaId !== null,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Result<CajaPaymentSummary>> => {
      if (!cajaId) return err(unknownError('No caja id.'));

      // Query payments joined via tabs.caja_session_id = cajaId
      const res = await supabaseQuery(() =>
        db
          .from('payments')
          .select('amount, method, tabs!inner(caja_session_id)')
          .eq('tabs.caja_session_id', cajaId)
          .is('deleted_at', null)
      );

      if (!res.ok) {
        logger.error('caja.payment_summary.fetch_failed', { message: res.error.message });
        return res as Result<CajaPaymentSummary>;
      }

      const rows = res.data as Array<{ amount: number; method: string }>;
      const summary = Object.fromEntries(
        PAYMENT_METHODS.map(method => [method, 0])
      ) as CajaPaymentSummary;

      for (const row of rows) {
        const amount = typeof row.amount === 'number' ? row.amount : 0;
        const parsed = PaymentMethodSchema.safeParse(row.method);
        if (parsed.success) summary[parsed.data] += amount;
      }

      return ok(summary);
    },
  });
}

// ============================================================================
// CAJA REPORT
// ============================================================================

export function useCajaReport(cajaId: string | null) {
  return useQuery({
    queryKey: cajaId ? cajaKeys.report(cajaId) : ['caja', 'report', '__none__'],
    enabled: cajaId !== null,
    queryFn: async (): Promise<Result<CajaReport>> => {
      if (!cajaId) return err(unknownError('No caja selected.'));

      const { data, error } = await db.rpc('get_caja_report', {
        p_caja_id: cajaId,
      });

      if (error) {
        logger.error('caja.report.rpc_error', { message: error.message });
        return err(unknownError(error));
      }

      try {
        return ok(CajaReportSchema.parse(data));
      } catch (e) {
        return err(unknownError(e));
      }
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// CAJA ENTRIES
// ============================================================================

const cajaEntryKeys = {
  all: ['caja-entries'] as const,
  bySession: (sessionId: string) => [...cajaEntryKeys.all, sessionId] as const,
};

function mapEntryRow(row: {
  id: string;
  caja_session_id: string;
  type: string;
  amount: unknown;
  concept: string;
  created_at: string;
  staff_id: string;
  staff_name: string | undefined;
}): Result<CajaEntry> {
  try {
    return ok(
      CajaEntrySchema.parse({
        id: row.id,
        cajaSessionId: row.caja_session_id,
        type: row.type,
        amount: Number(row.amount),
        concept: row.concept,
        createdAt: new Date(row.created_at),
        staffId: row.staff_id,
        staffName: row.staff_name,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

export function useCajaEntries(cajaSessionId: string | null) {
  return useQuery({
    queryKey: cajaSessionId ? cajaEntryKeys.bySession(cajaSessionId) : cajaEntryKeys.all,
    enabled: !!cajaSessionId,
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Result<CajaEntry[]>> => {
      if (!cajaSessionId) return err(unknownError('No caja session id.'));

      const res = await supabaseQuery(() =>
        db
          .from('caja_entries')
          .select('*, profiles(name)')
          .eq('caja_session_id', cajaSessionId)
          .order('created_at', { ascending: true })
      );

      if (!res.ok) return res as Result<CajaEntry[]>;

      const entries: CajaEntry[] = [];
      for (const rawRow of res.data as Record<string, unknown>[]) {
        const mapped = mapEntryRow({
          id: rawRow.id as string,
          caja_session_id: rawRow.caja_session_id as string,
          type: rawRow.type as string,
          amount: Number(rawRow.amount),
          concept: rawRow.concept as string,
          created_at: rawRow.created_at as string,
          staff_id: rawRow.staff_id as string,
          staff_name: (rawRow.profiles as { name?: string } | null)?.name,
        });
        if (!mapped.ok) return mapped as Result<CajaEntry[]>;
        entries.push(mapped.data);
      }
      return ok(entries);
    },
  });
}

export function useMutationCreateCajaEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CajaEntryCreate): Promise<Result<CajaEntry>> => {
      const res = await supabaseMutation(() =>
        db
          .from('caja_entries')
          .insert({
            caja_session_id: input.cajaSessionId,
            type: input.type,
            amount: input.amount,
            concept: input.concept,
            staff_id: input.staffId,
          })
          .select('*, profiles(name)')
          .single()
      );

      if (!res.ok) {
        logger.error('caja.entry.create.failed', { type: input.type });
        if (res.error.code === 'SUPABASE_ERROR') {
          return err({
            code: 'SUPABASE_ERROR' as AppError['code'],
            message: i18n.t('featOrders:registerCajaEntry.genericError'),
          });
        }
        return res as Result<CajaEntry>;
      }

      if (res.data == null) {
        return err(unknownError('No entry returned'));
      }

      const rawRow = res.data as Record<string, unknown>;
      const mapped = mapEntryRow({
        id: rawRow.id as string,
        caja_session_id: rawRow.caja_session_id as string,
        type: rawRow.type as string,
        amount: Number(rawRow.amount),
        concept: rawRow.concept as string,
        created_at: rawRow.created_at as string,
        staff_id: rawRow.staff_id as string,
        staff_name: (rawRow.profiles as { name?: string } | null)?.name,
      });

      if (mapped.ok) {
        logger.info('caja.entry.created', { type: input.type, amount: input.amount });
      }
      return mapped;
    },

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cajaEntryKeys.all });
      void queryClient.invalidateQueries({ queryKey: cajaKeys.all });
    },
  });
}

export function useMutationDeleteCajaEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string): Promise<Result<void>> => {
      const res = await supabaseMutation(() => db.from('caja_entries').delete().eq('id', entryId));

      if (!res.ok) {
        logger.error('caja.entry.delete.failed', { entryId });
        return err(res.error);
      }

      logger.info('caja.entry.deleted', { entryId });
      return ok(undefined);
    },

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cajaEntryKeys.all });
      void queryClient.invalidateQueries({ queryKey: cajaKeys.all });
    },
  });
}

// src/entities/print-job/model/queries.ts
/* eslint-disable i18next/no-literal-string */
// Broker-backed print-job audit read path (Phase 19: Store-Local Durable
// Printing Service). Structurally mirrors entities/audit-log/model/queries.ts
// (query-key factory + useInfiniteQuery), but the data source is the print
// broker's own HTTP API reached via two Tauri commands — never
// supabase.from(...)/useAuditLogs (RESEARCH.md Pitfall 5).
// i18next/no-literal-string: query-key namespace strings and Tauri `invoke()`
// command-name/wire-field-name string literals below are protocol
// identifiers, not UI copy — same category as audit-log/model/queries.ts's
// own file-level disable for the same rule.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

import { PrintJobDetailSchema, PrintJobSchema } from '@shared/lib/domain';
import type { PrintJob, PrintJobDetail, PrintJobFilters, PrintJobStatus } from '@shared/lib/domain';

const PAGE_SIZE = 50;

export const printJobKeys = {
  all: ['print-jobs'] as const,
  list: (filters: PrintJobFilters) => [...printJobKeys.all, 'list', filters] as const,
  detail: (jobId: string) => [...printJobKeys.all, 'detail', jobId] as const,
};

function mapPrintJobRow(row: Record<string, unknown>): PrintJob {
  return PrintJobSchema.parse({
    jobId: row['job_id'],
    status: row['status'],
    origin: row['origin'],
    printerName: row['printer_name'],
    attempts: row['attempts'],
    createdAt: new Date(Number(row['created_at'])),
    updatedAt: new Date(Number(row['updated_at'])),
  });
}

function mapPrintJobDetail(row: Record<string, unknown>): PrintJobDetail {
  const events = (row['events'] as Record<string, unknown>[] | undefined) ?? [];
  return PrintJobDetailSchema.parse({
    jobId: row['job_id'],
    status: row['status'],
    origin: row['origin'],
    printerName: row['printer_name'],
    attempts: row['attempts'],
    createdAt: new Date(Number(row['created_at'])),
    updatedAt: new Date(Number(row['updated_at'])),
    winSpoolJobId: row['win32_job_id'] ?? null,
    lastError: row['last_error'] ?? null,
    events: events.map(e => ({
      ts: new Date(Number(e['ts'])),
      category: e['category'],
      detail: e['detail'] ?? null,
    })),
  });
}

/**
 * Infinite query for print jobs with filters. Page size: 50. Ordered by
 * created_at DESC. Reads through the broker-backed `get_print_jobs` Tauri
 * command — never Supabase.
 */
export function usePrintJobs(filters: PrintJobFilters) {
  return useInfiniteQuery({
    queryKey: printJobKeys.list(filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<PrintJob[]> => {
      const page = await invoke<{ jobs: Record<string, unknown>[]; total: number }>('get_print_jobs', {
        filters: {
          origin: filters.origin,
          printerName: filters.printerName,
          status: filters.status,
          fromMs: filters.dateFrom ? filters.dateFrom.getTime() : undefined,
          toMs: filters.dateTo ? filters.dateTo.getTime() : undefined,
        },
        pageParam,
      });
      return page.jobs.map(mapPrintJobRow);
    },
    getNextPageParam: (lastPage: PrintJob[], allPages: PrintJob[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
  });
}

/**
 * Installed Windows printer queue names plus the OS-configured default —
 * powers the printer-select dropdown in Hardware Settings (closing the gap
 * where print jobs sent a hardcoded placeholder printer name that never
 * matched real hardware). Reads through the broker-backed `list_printers`
 * Tauri command — never Supabase. Static-ish data (installed printers rarely
 * change mid-session), so a longer staleTime than the job queries above.
 */
export function useAvailablePrinters() {
  return useQuery({
    queryKey: ['print-broker', 'printers'] as const,
    queryFn: async (): Promise<{ printers: string[]; default: string | null }> => {
      const result = await invoke<{ printers: string[]; default: string | null }>('list_printers');
      return result;
    },
    staleTime: 60 * 1000,
    retry: false,
  });
}

/** Statuses that still warrant polling — everything else is terminal (or
 * 'unknown', which does NOT self-resolve — see this plan's prohibitions). */
const POLLING_STATUSES = new Set<PrintJobStatus>(['accepted', 'submitted_to_os']);

/**
 * A single print job's live status + event history. Polls every 1500ms
 * while the last-known status is 'accepted'/'submitted_to_os'; stops polling
 * once terminal (os_reported_printed/failed/cancelled) or 'unknown' (never
 * auto-resolves — resolution is the user's explicit "Did this print?"
 * confirm only). Reads through the broker-backed `get_print_job` Tauri
 * command — never Supabase.
 *
 * Disabled (no fetch, no polling) when `jobId` is empty — callers like
 * ReprintButton track jobId in local state, undefined until their first
 * successful print attempt, and render `usePrintJob(jobId ?? '')` so no
 * badge/query exists before that first attempt (D-05).
 */
export function usePrintJob(jobId: string) {
  return useQuery({
    queryKey: printJobKeys.detail(jobId),
    enabled: jobId.length > 0,
    queryFn: async (): Promise<PrintJobDetail> => {
      const detail = await invoke<Record<string, unknown>>('get_print_job', { jobId });
      return mapPrintJobDetail(detail);
    },
    refetchInterval: (query: Query<PrintJobDetail>) => {
      const status = query.state.data?.status;
      return status && POLLING_STATUSES.has(status) ? 1500 : false;
    },
  });
}

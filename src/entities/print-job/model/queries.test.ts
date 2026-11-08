/**
 * Unit tests for entities/print-job's query layer (Phase 19, Plan 19-06).
 * Proves the broker-backed read path — invoke('get_print_jobs'/'get_print_job')
 * — never Supabase/useAuditLogs (RESEARCH.md Pitfall 5).
 */
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestQueryClient } from '@shared/lib/test-utils';

import { usePrintJob, usePrintJobs } from './queries';

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const mockedInvoke = vi.mocked(invoke);

describe('usePrintJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls invoke("get_print_jobs", ...) with the given filters and pageParam, returning parsed rows', async () => {
    mockedInvoke.mockResolvedValue({
      jobs: [
        {
          job_id: 'job-1',
          status: 'accepted',
          origin: 'receipt',
          printer_name: 'RECEIPT_PRINTER',
          attempts: 0,
          created_at: '1000',
          updated_at: '1000',
        },
      ],
      total: 1,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePrintJobs({}), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(mockedInvoke).toHaveBeenCalledWith('get_print_jobs', {
      filters: { origin: undefined, printerName: undefined, status: undefined, fromMs: undefined, toMs: undefined },
      pageParam: 0,
    });
    const rows = result.current.data?.pages.flat() ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe('job-1');
    expect(rows[0]?.status).toBe('accepted');
  });

  it('converts dateFrom/dateTo filters into fromMs/toMs epoch integers', async () => {
    mockedInvoke.mockResolvedValue({ jobs: [], total: 0 });
    const qc = createTestQueryClient();
    const dateFrom = new Date('2026-01-01T00:00:00.000Z');
    const dateTo = new Date('2026-01-02T00:00:00.000Z');

    renderHook(() => usePrintJobs({ dateFrom, dateTo }), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled();
    });
    expect(mockedInvoke).toHaveBeenCalledWith(
      'get_print_jobs',
      expect.objectContaining({ filters: expect.objectContaining({ fromMs: dateFrom.getTime(), toMs: dateTo.getTime() }) })
    );
  });
});

describe('usePrintJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls invoke("get_print_job", { jobId }) and returns the parsed detail including its events array', async () => {
    mockedInvoke.mockResolvedValue({
      job_id: 'job-1',
      status: 'failed',
      origin: 'receipt',
      printer_name: 'RECEIPT_PRINTER',
      attempts: 2,
      win32_job_id: 7,
      last_error: 'spooler reported JOB_STATUS_ERROR',
      created_at: '1000',
      updated_at: '2000',
      events: [{ ts: '1000', category: 'accepted', detail: null }],
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePrintJob('job-1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(mockedInvoke).toHaveBeenCalledWith('get_print_job', { jobId: 'job-1' });
    expect(result.current.data?.status).toBe('failed');
    expect(result.current.data?.events).toHaveLength(1);
    expect(result.current.data?.events[0]?.category).toBe('accepted');
  });

  it('stops polling (refetchInterval false) once status is terminal or unknown', async () => {
    mockedInvoke.mockResolvedValue({
      job_id: 'job-2',
      status: 'unknown',
      origin: 'receipt',
      printer_name: 'RECEIPT_PRINTER',
      attempts: 1,
      win32_job_id: null,
      last_error: null,
      created_at: '1000',
      updated_at: '2000',
      events: [],
    });

    const qc = createTestQueryClient();
    renderHook(() => usePrintJob('job-2'), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      const cache = qc.getQueryCache().findAll({ queryKey: ['print-jobs', 'detail', 'job-2'] });
      expect(cache[0]?.state.data).toBeDefined();
    });

    const cache = qc.getQueryCache().findAll({ queryKey: ['print-jobs', 'detail', 'job-2'] });
    const query = cache[0];
    expect(query).toBeDefined();
    const refetchInterval = query?.observers[0]?.options.refetchInterval;
    expect(typeof refetchInterval).toBe('function');
    if (typeof refetchInterval === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test-only cast of the cached Query
      expect(refetchInterval(query as never)).toBe(false);
    }
  });

  it('keeps polling every 1500ms while status is accepted/submitted_to_os', async () => {
    mockedInvoke.mockResolvedValue({
      job_id: 'job-3',
      status: 'submitted_to_os',
      origin: 'receipt',
      printer_name: 'RECEIPT_PRINTER',
      attempts: 1,
      win32_job_id: 5,
      last_error: null,
      created_at: '1000',
      updated_at: '2000',
      events: [],
    });

    const qc = createTestQueryClient();
    renderHook(() => usePrintJob('job-3'), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      const cache = qc.getQueryCache().findAll({ queryKey: ['print-jobs', 'detail', 'job-3'] });
      expect(cache[0]?.state.data).toBeDefined();
    });

    const cache = qc.getQueryCache().findAll({ queryKey: ['print-jobs', 'detail', 'job-3'] });
    const query = cache[0];
    const refetchInterval = query?.observers[0]?.options.refetchInterval;
    expect(typeof refetchInterval).toBe('function');
    if (typeof refetchInterval === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- test-only cast of the cached Query
      expect(refetchInterval(query as never)).toBe(1500);
    }
  });
});

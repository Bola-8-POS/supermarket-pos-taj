import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '@shared/lib/supabase';

import { useRolePermissions } from './queries';

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  Wrapper.displayName = 'TestQueryClientProvider';
  return Wrapper;
};

type FromMock = {
  select: ReturnType<typeof vi.fn>;
};

function mockFrom(result: { data: unknown; error: unknown }): void {
  const fromImpl: FromMock = {
    select: vi.fn().mockResolvedValue(result),
  };
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    fromImpl as unknown as ReturnType<typeof supabase.from>
  );
}

describe('useRolePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Map with correct role→action entries', async () => {
    const mockData = [
      { id: 'id1', role: 'cashier', action: 'create_order', created_at: '2026-01-01' },
      { id: 'id2', role: 'cashier', action: 'close_tab', created_at: '2026-01-01' },
      { id: 'id3', role: 'admin', action: 'manage_staff', created_at: '2026-01-01' },
    ];
    mockFrom({ data: mockData, error: null });

    const { result } = renderHook(() => useRolePermissions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const queryResult = result.current.data;
    expect(queryResult?.ok).toBe(true);
    if (!queryResult?.ok) return;

    const map = queryResult.data;
    expect(map.get('cashier')?.has('create_order')).toBe(true);
    expect(map.get('cashier')?.has('close_tab')).toBe(true);
    expect(map.get('admin')?.has('manage_staff')).toBe(true);
    expect(map.get('kitchen')).toBeUndefined();
  });

  it('returns ok with empty Map when no rows in DB', async () => {
    mockFrom({ data: [], error: null });

    const { result } = renderHook(() => useRolePermissions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const queryResult = result.current.data;
    expect(queryResult?.ok).toBe(true);
    if (!queryResult?.ok) return;
    expect(queryResult.data.size).toBe(0);
  });

  it('returns err with SUPABASE_ERROR when query fails', async () => {
    mockFrom({ data: null, error: { message: 'DB down' } });

    const { result } = renderHook(() => useRolePermissions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const queryResult = result.current.data;
    expect(queryResult).toBeDefined();
    if (!queryResult) return;
    expect(queryResult.ok).toBe(false);
    if (queryResult.ok) return;
    expect(queryResult.error.code).toBe('SUPABASE_ERROR');
    expect(queryResult.error.message).toBe('DB down');
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn().mockResolvedValue({ data: 'uuid', error: null }) },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '@shared/lib/supabase';

import { useMutationTogglePermission } from './useMutationTogglePermission';

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase).rpc;

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  Wrapper.displayName = 'TestQueryClientProvider';
  return Wrapper;
};

interface InsertChain {
  insert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function mockChain(opts: { insertError?: unknown; deleteError?: unknown }): {
  chain: InsertChain;
  insertCall: ReturnType<typeof vi.fn>;
  deleteCall: ReturnType<typeof vi.fn>;
  eqFirst: ReturnType<typeof vi.fn>;
  eqSecond: ReturnType<typeof vi.fn>;
} {
  const single = vi.fn().mockResolvedValue({ error: opts.insertError ?? null });
  const select = vi.fn().mockReturnValue({ single });
  const insertCall = vi.fn().mockReturnValue({ select });

  const eqSecond = vi.fn().mockResolvedValue({ error: opts.deleteError ?? null });
  const eqFirst = vi.fn().mockReturnValue({ eq: eqSecond });
  const deleteCall = vi.fn().mockReturnValue({ eq: eqFirst });

  const chain: InsertChain = {
    insert: insertCall,
    delete: deleteCall,
  };

  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    chain as unknown as ReturnType<typeof supabase.from>
  );

  return { chain, insertCall, deleteCall, eqFirst, eqSecond };
}

describe('useMutationTogglePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables a permission: INSERTs (role, action) row and resolves to ok(null)', async () => {
    const { insertCall } = mockChain({});

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    const res = await result.current.mutateAsync({
      role: 'cashier',
      action: 'create_order',
      enabled: true,
    });

    expect(insertCall).toHaveBeenCalledWith({
      role: 'cashier',
      action: 'create_order',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toBeNull();
  });

  it('disables a permission: DELETEs row matching (role, action) and resolves to ok(null)', async () => {
    const { deleteCall, eqFirst, eqSecond } = mockChain({});

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    const res = await result.current.mutateAsync({
      role: 'kitchen',
      action: 'clock_in',
      enabled: false,
    });

    expect(deleteCall).toHaveBeenCalled();
    expect(eqFirst).toHaveBeenCalledWith('role', 'kitchen');
    expect(eqSecond).toHaveBeenCalledWith('action', 'clock_in');
    expect(res.ok).toBe(true);
  });

  it('returns err with SUPABASE_ERROR code when supabase insert fails', async () => {
    mockChain({ insertError: { message: 'unique constraint violation' } });

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    const res = await result.current.mutateAsync({
      role: 'admin',
      action: 'manage_staff',
      enabled: true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SUPABASE_ERROR');
    expect(res.error.message).toBe('unique constraint violation');

    // Wait for onSuccess to NOT invalidate (since result.ok=false)
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('records a permission.toggle audit call after a successful enable', async () => {
    mockChain({});

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({
      role: 'cashier',
      action: 'create_order',
      enabled: true,
    });

    expect(mockedRpc).toHaveBeenCalledWith(
      'record_audit',
      expect.objectContaining({
        p_action: 'permission.toggle',
        p_source: 'client',
      })
    );
  });

  it('records a permission.toggle audit call after a successful disable', async () => {
    mockChain({});

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({
      role: 'kitchen',
      action: 'clock_in',
      enabled: false,
    });

    expect(mockedRpc).toHaveBeenCalledWith(
      'record_audit',
      expect.objectContaining({
        p_action: 'permission.toggle',
        p_source: 'client',
      })
    );
  });

  it('still resolves ok(null) when the audit rpc call fails (non-fatal)', async () => {
    mockChain({});
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'audit insert failed' },
    } as never);

    const { result } = renderHook(() => useMutationTogglePermission(), {
      wrapper: createWrapper(),
    });

    const res = await result.current.mutateAsync({
      role: 'cashier',
      action: 'create_order',
      enabled: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toBeNull();
  });
});

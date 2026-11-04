/* eslint-disable import/order -- vi.mock factories must precede imports */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsOnline = vi.hoisted(() => vi.fn(() => true));
const mockProbe = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('@shared/lib/connectivity', () => ({
  isOnline: mockIsOnline,
  probeReachability: mockProbe,
  useOnlineStatus: () => true,
}));

const maybeSingle = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn(() => Promise.resolve({ error: null })));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }),
    rpc,
  },
}));

// The row mapper is exercised by the product entity's own tests; here it only
// has to pass a row through.
vi.mock('@entities/product/model/queries', () => ({
  mapProductRow: (row: unknown) => ({ ok: true, data: row }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Product } from '@shared/lib/domain';
import { useLookupProductByBarcode } from './useLookupProductByBarcode';

function wrapperWithProducts(products: Partial<Product>[]) {
  const qc = new QueryClient();
  // Same shape useProducts() caches: a Result, not a bare array.
  qc.setQueryData(['products'], { ok: true, data: products });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useLookupProductByBarcode offline behaviour', () => {
  beforeEach(() => {
    mockIsOnline.mockReturnValue(true);
    mockProbe.mockResolvedValue(true);
    maybeSingle.mockReset();
    rpc.mockClear();
  });

  it('returns a cached product while offline without touching the network', async () => {
    mockIsOnline.mockReturnValue(false);
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([{ id: 'p1', barcode: '123', isActive: true }]),
    });
    const res = await result.current.lookup('123');
    expect(res.ok).toBe(true);
    expect(res.ok && res.data?.id).toBe('p1');
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('returns a typed NETWORK_OFFLINE error on a cache miss while offline, without auditing a failed scan', async () => {
    mockIsOnline.mockReturnValue(false);
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([]),
    });
    const res = await result.current.lookup('999');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(maybeSingle).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('still queries the server on a cache miss while online', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'p2', barcode: '999' }, error: null });
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([]),
    });
    const res = await result.current.lookup('999');
    expect(res.ok).toBe(true);
    expect(res.ok && res.data?.id).toBe('p2');
    expect(maybeSingle).toHaveBeenCalled();
  });

  it('resolves a genuine online miss to null and audits the failed scan', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([]),
    });
    const res = await result.current.lookup('999');
    expect(res).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledWith('record_audit', expect.objectContaining({ p_action: 'barcode.scan_failed' }));
  });

  it('returns an error, not a false "not found", when the server lookup fails', async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    });
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([]),
    });
    const res = await result.current.lookup('999');
    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports NETWORK_OFFLINE when the server lookup fails and a probe finds the backend unreachable (WAN down before the monitor noticed)', async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    });
    mockProbe.mockResolvedValue(false);
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([]),
    });
    const res = await result.current.lookup('999');
    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks the server first while online, so a price or status changed since the cache was restored wins', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'p1', barcode: '123', basePrice: 12 }, error: null });
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([{ id: 'p1', barcode: '123', basePrice: 10 }]),
    });
    const res = await result.current.lookup('123');
    expect(maybeSingle).toHaveBeenCalled();
    expect(res.ok && res.data?.basePrice).toBe(12);
  });

  it('falls back to the cached product when the server lookup fails and the backend is unreachable', async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    });
    mockProbe.mockResolvedValue(false);
    const { result } = renderHook(() => useLookupProductByBarcode(), {
      wrapper: wrapperWithProducts([{ id: 'p1', barcode: '123', basePrice: 10 }]),
    });
    const res = await result.current.lookup('123');
    expect(res.ok && res.data?.id).toBe('p1');
  });
});

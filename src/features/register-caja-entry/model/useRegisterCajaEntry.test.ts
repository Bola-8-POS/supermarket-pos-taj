import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as EntityCaja from '@entities/caja';
import { useCajaStore } from '@entities/caja/model/store';
import type { CajaSession } from '@shared/lib/domain';
import { ok, err } from '@shared/lib/result';

// ---------------------------------------------------------------------------
// Mock useMutationCreateCajaEntry from the caja barrel
// ---------------------------------------------------------------------------

const mockMutateAsync = vi.fn();

vi.mock('@entities/caja', async importOriginal => {
  const actual = await importOriginal<typeof EntityCaja>();
  return {
    ...actual,
    useMutationCreateCajaEntry: () => ({
      mutateAsync: mockMutateAsync,
      isPending: false,
    }),
  };
});

// ---------------------------------------------------------------------------
// Import the hook AFTER mocks are set up
// ---------------------------------------------------------------------------

import { useRegisterCajaEntry } from './useRegisterCajaEntry';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testCaja: CajaSession = {
  id: 'caja-uuid-001',
  terminalId: 'POS-1',
  openedAt: new Date('2026-04-21T08:00:00.000Z'),
  closedAt: null,
  openedBy: 'staff-uuid-001',
  closedBy: null,
  openingCash: 500,
  closingCash: null,
  notes: null,
  status: 'open',
  openedByName: 'Alex',
  closedByName: null,
};

const entryInput = {
  type: 'expense' as const,
  amount: 50,
  concept: 'Office supplies',
  staffId: 'staff-uuid-001',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRegisterCajaEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCajaStore.setState({ currentCaja: null, isCajaOpen: false });
  });

  it('returns err(NOT_FOUND) when there is no open caja session', async () => {
    const { result } = renderHook(() => useRegisterCajaEntry());

    let res: Awaited<ReturnType<typeof result.current.registerEntry>> | undefined;
    await act(async () => {
      res = await result.current.registerEntry(entryInput);
    });

    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
    }
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('calls mutateAsync with correct cajaSessionId and a minted idempotencyKey when caja is open', async () => {
    useCajaStore.setState({ currentCaja: testCaja, isCajaOpen: true });
    mockMutateAsync.mockResolvedValueOnce(
      ok({ id: 'entry-uuid-001', ...entryInput, cajaSessionId: testCaja.id, createdAt: new Date() })
    );

    const { result } = renderHook(() => useRegisterCajaEntry());

    await act(async () => {
      await result.current.registerEntry(entryInput);
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      ...entryInput,
      cajaSessionId: testCaja.id,
      idempotencyKey: expect.any(String) as string,
    });
  });

  it('mints an idempotency key once and reuses it across retries until resetIdempotencyKey() is called', async () => {
    useCajaStore.setState({ currentCaja: testCaja, isCajaOpen: true });
    mockMutateAsync.mockResolvedValue(
      ok({ id: 'entry-uuid-001', ...entryInput, cajaSessionId: testCaja.id, createdAt: new Date() })
    );

    const { result } = renderHook(() => useRegisterCajaEntry());

    await act(async () => {
      await result.current.registerEntry(entryInput);
      await result.current.registerEntry(entryInput);
    });

    const firstKey = (mockMutateAsync.mock.calls[0]?.[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    const secondKey = (mockMutateAsync.mock.calls[1]?.[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);

    act(() => {
      result.current.resetIdempotencyKey();
    });
    await act(async () => {
      await result.current.registerEntry(entryInput);
    });
    const thirdKey = (mockMutateAsync.mock.calls[2]?.[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    expect(thirdKey).not.toBe(firstKey);
  });

  it('returns mutation result on success', async () => {
    useCajaStore.setState({ currentCaja: testCaja, isCajaOpen: true });
    const successData = {
      id: 'entry-uuid-001',
      ...entryInput,
      cajaSessionId: testCaja.id,
      createdAt: new Date(),
    };
    mockMutateAsync.mockResolvedValueOnce(ok(successData));

    const { result } = renderHook(() => useRegisterCajaEntry());

    let res: Awaited<ReturnType<typeof result.current.registerEntry>> | undefined;
    await act(async () => {
      res = await result.current.registerEntry(entryInput);
    });

    expect(res?.ok).toBe(true);
  });

  it('discards the idempotency key after a VALIDATION_ERROR (idempotency replay rejection), so the next attempt mints a fresh one', async () => {
    useCajaStore.setState({ currentCaja: testCaja, isCajaOpen: true });
    mockMutateAsync.mockResolvedValueOnce(
      err({ code: 'VALIDATION_ERROR' as const, message: 'This entry was already submitted with different details.' })
    );
    mockMutateAsync.mockResolvedValueOnce(
      ok({ id: 'entry-uuid-002', ...entryInput, cajaSessionId: testCaja.id, createdAt: new Date() })
    );

    const { result } = renderHook(() => useRegisterCajaEntry());

    await act(async () => {
      await result.current.registerEntry(entryInput);
      // No resetIdempotencyKey() call here — the dialog stays open on the
      // same page, so the key must be discarded by registerEntry itself once
      // it sees the replay rejection, not left for the caller to notice.
      await result.current.registerEntry(entryInput);
    });

    const firstKey = (mockMutateAsync.mock.calls[0]?.[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    const secondKey = (mockMutateAsync.mock.calls[1]?.[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it('returns error result on mutation failure', async () => {
    useCajaStore.setState({ currentCaja: testCaja, isCajaOpen: true });
    const errorResult = err({ code: 'SUPABASE_ERROR' as const, message: 'DB error' });
    mockMutateAsync.mockResolvedValueOnce(errorResult);

    const { result } = renderHook(() => useRegisterCajaEntry());

    let res: Awaited<ReturnType<typeof result.current.registerEntry>> | undefined;
    await act(async () => {
      res = await result.current.registerEntry(entryInput);
    });

    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
    }
  });
});

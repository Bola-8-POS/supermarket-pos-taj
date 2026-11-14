/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMutationCloseCaja } from '@entities/caja/model/queries';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import type { Staff } from '@shared/lib/domain';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import { useMutationClockOut } from './queries';
import { useStaffStore } from './store';

// makeSale()'s default seller is this cashier.
const SELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';

/* eslint-disable @typescript-eslint/unbound-method -- vi.mock'd supabase methods */
const mockedRpc = vi.mocked(supabase).rpc;
const mockedFrom = vi.mocked(supabase).from;
const mockedSignOut = vi.mocked(supabase.auth.signOut);
/* eslint-enable @typescript-eslint/unbound-method */

const RECONCILIATION = {
  openingCash: 100,
  cashSales: 50,
  cashIn: 0,
  cashOut: 0,
  expectedCash: 150,
  closingCash: 150,
  variance: 0,
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: createTestQueryClient() }, children);
}

function seed(...records: OfflineSale[]): void {
  useOfflineSaleStore.setState({ records });
}

function signInAs(id: string): void {
  useStaffStore.setState({
    currentStaff: {
      id,
      name: 'Test',
      role: 'cashier',
      isActive: true,
      mustChangePin: false,
      locale: 'es-MX',
    } as Staff,
    isAuthenticated: true,
  });
}

const closeCaja = async () => {
  const { result } = renderHook(() => useMutationCloseCaja(), { wrapper });
  return result.current.mutateAsync({
    cajaId: 'caja-1',
    closedBy: SELLER,
    closingCash: 150,
    notes: undefined,
  });
};

const clockOut = async (staffId: string) => {
  const { result } = renderHook(() => useMutationClockOut(), { wrapper });
  return result.current.mutateAsync({ shiftId: 'shift-1', staffId, closingCash: 0 });
};

describe('offline sales block close caja, clock-out and sign-out (Ruling 13 / R28)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seed();
    signInAs(SELLER);
    mockedSignOut.mockResolvedValue({ error: null });
    mockedRpc.mockResolvedValue({
      data: { ok: true, cashReconciliation: RECONCILIATION },
      error: null,
    } as never);
  });

  it('a queued or replaying sale still blocks sign-out and clock-out', async () => {
    for (const status of ['queued', 'replaying'] as const) {
      seed(makeSale({ status }));

      const closed = await closeCaja();
      expect(closed.ok, `close caja while ${status}`).toBe(false);
      if (!closed.ok) expect(closed.error.code).toBe('OFFLINE_SALES_PENDING');

      const clocked = await clockOut(SELLER);
      expect(clocked.ok, `clock-out while ${status}`).toBe(false);
      if (!clocked.ok) expect(clocked.error.code).toBe('OFFLINE_SALES_PENDING');

      const signedOut = await useStaffStore.getState().logout();
      expect(signedOut.ok, `sign-out while ${status}`).toBe(false);
      if (!signedOut.ok) expect(signedOut.error.code).toBe('OFFLINE_SALES_PENDING');
      expect(useStaffStore.getState().isAuthenticated).toBe(true);
    }
    expect(mockedRpc).not.toHaveBeenCalled();
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(mockedSignOut).not.toHaveBeenCalled();

    seed(
      makeSale({ id: 'a1111111-1111-4111-8111-111111111111', status: 'confirmed' }),
      makeSale({ id: 'b2222222-2222-4222-8222-222222222222', status: 'resolved' })
    );
    expect((await closeCaja()).ok).toBe(true);
    await clockOut(SELLER);
    expect(mockedFrom).toHaveBeenCalledWith('shifts');
    expect((await useStaffStore.getState().logout()).ok).toBe(true);
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
  });

  it("a sale in review does not block its cashier's sign-out", async () => {
    seed(makeSale({ status: 'needs_review' }));

    const res = await useStaffStore.getState().logout();

    expect(res.ok).toBe(true);
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
  });

  it('a sale in review does not block clock-out', async () => {
    seed(makeSale({ status: 'needs_review' }));

    await clockOut(SELLER);

    expect(mockedFrom).toHaveBeenCalledWith('shifts');
  });

  it('a sale in review still blocks close caja', async () => {
    seed(makeSale({ status: 'needs_review' }));

    const closed = await closeCaja();

    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.code).toBe('OFFLINE_SALES_PENDING');
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("sign-out and clock-out are not refused for another cashier's pending sale", async () => {
    seed(makeSale({ staffId: OTHER, status: 'queued' }));

    await clockOut(SELLER);
    expect(mockedFrom).toHaveBeenCalledWith('shifts');

    const res = await useStaffStore.getState().logout();
    expect(res.ok).toBe(true);
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
  });

  it('a manager cannot clock out a cashier who has a pending offline sale', async () => {
    // R28a: the key is the SHIFT OWNER, not the signed-in user - the replay needs the seller's shift open.
    seed(makeSale({ staffId: SELLER, status: 'queued' }));
    signInAs(OTHER);

    const refused = await clockOut(SELLER);

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('OFFLINE_SALES_PENDING');
    expect(mockedFrom).not.toHaveBeenCalled();

    // and the reverse: a cashier with a pending sale clocking out someone else's shift is not refused
    signInAs(SELLER);
    await clockOut(OTHER);
    expect(mockedFrom).toHaveBeenCalledWith('shifts');
  });

  it('the refusal message states the pending count; only close caja mentions review', async () => {
    seed(
      makeSale({ id: 'a1111111-1111-4111-8111-111111111111', status: 'queued' }),
      makeSale({ id: 'b2222222-2222-4222-8222-222222222222', status: 'replaying' }),
      makeSale({ id: 'c3333333-3333-4333-8333-333333333333', status: 'needs_review' })
    );

    const res = await useStaffStore.getState().logout();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('2 offline sales');
      expect(res.error.message).not.toContain('review');
    }

    const closed = await closeCaja();
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.error.message).toContain('3 offline sales');
      expect(closed.error.message).toContain("1 of them needs a manager's review");
    }
  });

  it('a forced sign-out is never refused', async () => {
    seed(makeSale({ status: 'needs_review' }));

    const res = await useStaffStore.getState().logout({ force: true });

    expect(res.ok).toBe(true);
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
    expect(useStaffStore.getState().currentStaff).toBeNull();
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });
});

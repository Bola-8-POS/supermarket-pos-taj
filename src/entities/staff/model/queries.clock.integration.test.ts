vi.unmock('@shared/lib/supabase');
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import {
  staffKeys,
  useMutationClockIn,
  useMutationClockOut,
  useShiftClosePreview,
} from './queries';
import { useStaffStore } from './store';

// Seeded staff IDs from the cloud Supabase project (run: supabase auth list)
const STAFF_ID = '4d77ef2b-c99d-4dd1-a572-2638ab427496'; // Alex Martinez (alex@barpos.dev)
const OTHER_STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e'; // Jamie Chen (jamie@barpos.dev)

// Deterministic test IDs for setup/teardown isolation
const TEST_SHIFT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEST_TAB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEST_ORDER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEST_PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// Track shifts inserted by clock-in mutation so we can clean them up
let clockInShiftId: string | null = null;

beforeAll(async () => {
  await supabase.auth.signInWithPassword({
    email: 'alex@barpos.dev',
    password: '123456',
  });
});

afterAll(async () => {
  await supabase.auth.signOut();
});

// ─── useShiftClosePreview ────────────────────────────────────────────────────

describe('useShiftClosePreview', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    // Create test shift with known clock_in
    await testDb.from('shifts').upsert({
      id: TEST_SHIFT_ID,
      staff_id: STAFF_ID,
      opening_cash: 50,
      clock_in: '2026-04-17T08:00:00.000Z',
    });
  });

  afterEach(async () => {
    await testDb.from('payments').delete().eq('id', TEST_PAYMENT_ID);
    await testDb.from('orders').delete().eq('id', TEST_ORDER_ID);
    await testDb.from('tabs').delete().eq('id', TEST_TAB_ID);
    await testDb.from('shifts').delete().eq('id', TEST_SHIFT_ID);
    queryClient.clear();
  });

  it('does not run query when shiftId or staffId is null', () => {
    const { result } = renderHook(() => useShiftClosePreview(null, null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('returns zeros when no tabs exist for shift and loads shift start', async () => {
    const { result } = renderHook(() => useShiftClosePreview(TEST_SHIFT_ID, STAFF_ID), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const d = result.current.data;
    expect(d?.orderCount).toBe(0);
    expect(d?.totalSales).toBe(0);
    expect(d?.shiftStartedAt).toEqual(new Date('2026-04-17T08:00:00.000Z'));
  });

  it('aggregates orders and payments when tabs exist', async () => {
    // Payments RLS: only managers/admins can SELECT — sign in as Jamie (manager) for this test
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });

    await testDb.from('tabs').upsert({
      id: TEST_TAB_ID,
      shift_id: TEST_SHIFT_ID,
      staff_id: STAFF_ID,
      status: 'open',
      customer_name: 'Test Customer',
    });

    await testDb.from('orders').upsert({
      id: TEST_ORDER_ID,
      tab_id: TEST_TAB_ID,
      staff_id: STAFF_ID,
      status: 'pending',
    });

    // idempotency_key is NOT NULL — required field in payments table
    await testDb.from('payments').upsert({
      id: TEST_PAYMENT_ID,
      tab_id: TEST_TAB_ID,
      processed_by: STAFF_ID,
      amount: 50,
      method: 'cash',
      idempotency_key: `test-${TEST_PAYMENT_ID}`,
    });

    const { result } = renderHook(() => useShiftClosePreview(TEST_SHIFT_ID, STAFF_ID), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.orderCount).toBe(1);
    expect(result.current.data?.totalSales).toBe(50);

    // Restore Alex's session for subsequent tests in this describe block
    await supabase.auth.signInWithPassword({ email: 'alex@barpos.dev', password: '123456' });
  });
});

// ─── useMutationClockIn ──────────────────────────────────────────────────────

describe('useMutationClockIn', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    clockInShiftId = null;
    useStaffStore.setState({
      currentStaff: {
        id: STAFF_ID,
        name: 'Alex Martinez',
        role: 'cashier',
        isActive: true,
        mustChangePin: false,
        locale: 'es-MX',
      },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Clean up any shift inserted by the clock-in mutation
    if (clockInShiftId) {
      await testDb.from('shifts').delete().eq('id', clockInShiftId);
      clockInShiftId = null;
    }
    // Also clean up any open shifts for test staff created in this test run
    await testDb.from('shifts').delete().eq('staff_id', STAFF_ID).is('clock_out', null);
    useStaffStore.getState().logout();
    queryClient.clear();
  });

  it('applies optimistic shift for current staff and replaces on success', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useMutationClockIn(), { wrapper });

    const mutationResult = await result.current.mutateAsync({
      staffId: STAFF_ID,
      openingCash: 75,
    });

    expect(mutationResult.ok).toBe(true);
    if (mutationResult.ok) {
      clockInShiftId = mutationResult.data.id; // capture for cleanup
    }

    const shiftAfter = useStaffStore.getState().currentShift;
    expect(shiftAfter).not.toBeNull();
    expect(shiftAfter?.staffId).toBe(STAFF_ID);
    expect(shiftAfter?.openingCash).toBe(75);
    expect(shiftAfter?.clockOut).toBeNull();

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: staffKeys.openShifts() })
    );
  });

  it('does not apply optimistic shift for other staff', async () => {
    // Sign in as OTHER_STAFF_ID for this test
    await supabase.auth.signInWithPassword({
      email: 'jamie@barpos.dev',
      password: '567890',
    });

    useStaffStore.setState({
      currentStaff: {
        id: STAFF_ID, // current user is STAFF_ID
        name: 'Alex Martinez',
        role: 'cashier',
        isActive: true,
        mustChangePin: false,
        locale: 'es-MX',
      },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });

    const { result } = renderHook(() => useMutationClockIn(), { wrapper });

    const mutationResult = await result.current.mutateAsync({
      staffId: OTHER_STAFF_ID, // clocking in a different staff
      openingCash: 10,
    });

    if (mutationResult.ok) {
      clockInShiftId = mutationResult.data.id;
    }

    // Store should NOT be updated because the clocked-in staff ≠ current staff
    expect(useStaffStore.getState().currentShift).toBeNull();

    // Restore STAFF_ID auth
    await supabase.auth.signInWithPassword({
      email: 'alex@barpos.dev',
      password: '123456',
    });
  });
});

// ─── useMutationClockOut ─────────────────────────────────────────────────────

describe('useMutationClockOut', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  let openShiftId: string;

  beforeEach(async () => {
    // Re-authenticate in case a prior describe's afterEach called logout() → signOut()
    await supabase.auth.signInWithPassword({ email: 'alex@barpos.dev', password: '123456' });

    // Insert a real open shift to clock out from
    const { data } = await testDb
      .from('shifts')
      .insert({
        staff_id: STAFF_ID,
        opening_cash: 50,
        clock_in: '2026-04-17T08:00:00.000Z',
      })
      .select('id')
      .single();

    openShiftId = data?.id ?? '';

    useStaffStore.setState({
      currentStaff: {
        id: STAFF_ID,
        name: 'Alex Martinez',
        role: 'cashier',
        isActive: true,
        mustChangePin: false,
        locale: 'es-MX',
      },
      currentShift: {
        id: openShiftId,
        staffId: STAFF_ID,
        clockIn: new Date('2026-04-17T08:00:00.000Z'),
        clockOut: null,
        openingCash: 50,
        closingCash: null,
      },
      staffList: [],
      isAuthenticated: true,
    });
  });

  afterEach(async () => {
    if (openShiftId) {
      await testDb.from('shifts').delete().eq('id', openShiftId);
    }
    useStaffStore.getState().logout();
    queryClient.clear();
  });

  it('optimistically sets clockOut then commits server shift', async () => {
    const { result } = renderHook(() => useMutationClockOut(), { wrapper });

    const mutationResult = await result.current.mutateAsync({
      shiftId: openShiftId,
      staffId: STAFF_ID,
      closingCash: 120,
    });

    expect(mutationResult.ok).toBe(true);
    if (mutationResult.ok) {
      expect(mutationResult.data.closingCash).toBe(120);
      expect(mutationResult.data.clockOut).toBeInstanceOf(Date);
    }

    expect(useStaffStore.getState().currentShift?.clockOut).toBeInstanceOf(Date);

    // Verify the DB was actually updated
    const { data: shift } = await testDb
      .from('shifts')
      .select('clock_out, closing_cash')
      .eq('id', openShiftId)
      .single();
    expect(shift?.closing_cash).toBe(120);
    expect(shift?.clock_out).not.toBeNull();
  });
});

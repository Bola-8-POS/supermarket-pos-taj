vi.unmock('@shared/lib/supabase');
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabKeys } from '@entities/tab/model/queries';
import { useTabStore } from '@entities/tab/model/store';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useCloseTab } from '../index';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Seeded staff ID from the cloud Supabase project (Alex Martinez)
const STAFF_ID = '4d77ef2b-c99d-4dd1-a572-2638ab427496';
// Unique IDs for test isolation
const TEST_SHIFT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEST_TAB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('useCloseTab', () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeAll(async () => {
    // Sign in as seeded test user so RLS-protected mutations work
    await supabase.auth.signInWithPassword({
      email: 'alex@barpos.dev',
      password: '123456',
    });

    // Create a test shift (service role bypasses RLS)
    await testDb.from('shifts').upsert({
      id: TEST_SHIFT_ID,
      staff_id: STAFF_ID,
      opening_cash: 0,
    });
  });

  afterAll(async () => {
    await testDb.from('tabs').delete().eq('id', TEST_TAB_ID);
    await testDb.from('shifts').delete().eq('id', TEST_SHIFT_ID);
    await supabase.auth.signOut();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient.clear();

    // Seed useTabStore with a clearSelection stub
    useTabStore.setState({ clearSelection: vi.fn() } as never);

    // Insert a fresh open tab before each test
    await testDb.from('tabs').upsert({
      id: TEST_TAB_ID,
      shift_id: TEST_SHIFT_ID,
      staff_id: STAFF_ID,
      status: 'open',
      customer_name: 'Test Customer',
    });
  });

  afterEach(async () => {
    // Reset tab status back to open (or delete — we re-create in beforeEach anyway)
    await testDb.from('tabs').delete().eq('id', TEST_TAB_ID);
  });

  it('closes tab', async () => {
    const { result } = renderHook(() => useCloseTab(), { wrapper });
    const closeResult = await result.current.closeTab(TEST_TAB_ID);

    expect(closeResult.ok).toBe(true);
    if (closeResult.ok) {
      expect(closeResult.data).toBeUndefined();
    }
    expect(toast.success).toHaveBeenCalledWith('Tab closed successfully.');
    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: tabKeys.lists() })
    );

    // Verify tab is actually closed in the DB
    const { data: tab } = await testDb.from('tabs').select('*').eq('id', TEST_TAB_ID).single();
    expect(tab?.status).toBe('closed');
  });
});

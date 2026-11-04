import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  approveOffline,
  availableOfflineGrants,
  pendingGrantUses,
  rememberApprovalVerifier,
  storeOfflineGrants,
} from '@entities/staff/model/offlineApproval';
import { useStaffStore } from '@entities/staff/model/store';
import { supabase } from '@shared/lib/supabase';

import { reportOfflineApprovals } from './reportOfflineApprovals';
import { useIssueOfflineApprovals } from './useIssueOfflineApprovals';

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase.rpc);

const MANAGER = '22222222-2222-4222-8222-222222222222';
const CASHIER = '11111111-1111-4111-8111-111111111111';
const GRANT_A = '33333333-3333-4333-8333-333333333333';
const GRANT_B = '44444444-4444-4444-8444-444444444444';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useIssueOfflineApprovals', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedRpc.mockReset();
  });

  it('issues grants for this terminal and keeps them for offline use', async () => {
    const expires = new Date(Date.now() + 8 * 3_600_000).toISOString();
    mockedRpc.mockResolvedValueOnce({
      data: [GRANT_A, GRANT_B].map(id => ({
        id,
        action: 'reopen_tab',
        terminal_id: 'POS-1',
        granted_by: MANAGER,
        requested_for: CASHIER,
        expires_at: expires,
      })),
      error: null,
    } as never);
    await rememberApprovalVerifier(CASHIER, '123456', 'cashier');
    const { result } = renderHook(() => useIssueOfflineApprovals(), { wrapper });

    const res = await result.current.mutateAsync({
      approvalId: 'ticket-1',
      approverId: MANAGER,
      action: 'reopen_tab',
      count: 2,
      validMinutes: 240,
    });

    expect(res.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledWith('issue_offline_approval_grants', {
      p_approval_id: 'ticket-1',
      p_approver_id: MANAGER,
      p_action: 'reopen_tab',
      p_count: 2,
      p_valid_minutes: 240,
      p_terminal_id: 'POS-1',
    });
    expect(availableOfflineGrants('reopen_tab')).toEqual([
      { id: GRANT_A, action: 'reopen_tab', grantedBy: MANAGER, requestedFor: CASHIER, terminalId: 'POS-1', expiresAt: Date.parse(expires) },
      { id: GRANT_B, action: 'reopen_tab', grantedBy: MANAGER, requestedFor: CASHIER, terminalId: 'POS-1', expiresAt: Date.parse(expires) },
    ]);
  });

  it('stores nothing when the server refuses', async () => {
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'APPROVAL_REQUIRED: INVALID_APPROVAL', code: 'P0001', details: '', hint: '' },
    } as never);
    const { result } = renderHook(() => useIssueOfflineApprovals(), { wrapper });

    const res = await result.current.mutateAsync({
      approvalId: 'ticket-1',
      approverId: MANAGER,
      action: 'reopen_tab',
      count: 2,
      validMinutes: 240,
    });

    expect(res.ok).toBe(false);
    expect(availableOfflineGrants()).toEqual([]);
  });
});

describe('reportOfflineApprovals', () => {
  beforeEach(async () => {
    localStorage.clear();
    mockedRpc.mockReset();
    storeOfflineGrants([
      { id: GRANT_A, action: 'process_refund', grantedBy: MANAGER, requestedFor: CASHIER, terminalId: 'POS-1', expiresAt: Date.now() + 60_000 },
    ]);
    await rememberApprovalVerifier(CASHIER, '123456', 'cashier');
    await approveOffline('process_refund', '123456');
    useStaffStore.setState({ currentStaff: { id: CASHIER } as never });
  });

  it('reports each logged offline use and forgets it once the server has it', async () => {
    mockedRpc.mockResolvedValueOnce({ data: 1, error: null } as never);

    await reportOfflineApprovals();

    expect(mockedRpc).toHaveBeenCalledWith('report_offline_approvals', {
      p_uses: [expect.objectContaining({ grantId: GRANT_A, usedBy: CASHIER })],
    });
    expect(pendingGrantUses()).toEqual([]);
  });

  it('keeps the uses for the next attempt when reporting fails', async () => {
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'AUTH_REQUIRED: authentication required', code: 'P0001', details: '', hint: '' },
    } as never);

    await reportOfflineApprovals();

    expect(pendingGrantUses()).toHaveLength(1);
  });

  describe('with a mixed queue', () => {
    const OTHER = '55555555-5555-4555-8555-555555555555';
    const GRANT_C = '66666666-6666-4666-8666-666666666666';

    beforeEach(async () => {
      storeOfflineGrants([
        { id: GRANT_C, action: 'process_refund', grantedBy: MANAGER, requestedFor: OTHER, terminalId: 'POS-1', expiresAt: Date.now() + 60_000 },
      ]);
      await rememberApprovalVerifier(OTHER, '654321', 'cashier');
      await approveOffline('process_refund', '654321');
      expect(pendingGrantUses()).toHaveLength(2);
    });

    it('sends only its own uses and leaves other cashiers uses queued', async () => {
      mockedRpc.mockResolvedValueOnce({ data: 1, error: null } as never);

      await reportOfflineApprovals();

      expect(mockedRpc).toHaveBeenCalledWith('report_offline_approvals', {
        p_uses: [expect.objectContaining({ grantId: GRANT_A, usedBy: CASHIER })],
      });
      expect(pendingGrantUses().map(u => u.grantId)).toEqual([GRANT_C]);
    });

    it('keeps its own uses when the report fails, and still holds the others', async () => {
      mockedRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'AUTH_FORBIDDEN: nope', code: 'P0001', details: '', hint: '' },
      } as never);

      await reportOfflineApprovals();

      expect(pendingGrantUses().map(u => u.grantId).sort()).toEqual([GRANT_A, GRANT_C].sort());
    });

    it('does not call the server when the signed-in user has nothing queued', async () => {
      useStaffStore.setState({ currentStaff: { id: '77777777-7777-4777-8777-777777777777' } as never });
      await reportOfflineApprovals();
      expect(mockedRpc).not.toHaveBeenCalled();
      expect(pendingGrantUses()).toHaveLength(2);
    });
  });

  it('does not call the server when nothing is pending', async () => {
    mockedRpc.mockResolvedValueOnce({ data: 1, error: null } as never);
    await reportOfflineApprovals();
    mockedRpc.mockClear();

    await reportOfflineApprovals();

    expect(mockedRpc).not.toHaveBeenCalled();
  });
});

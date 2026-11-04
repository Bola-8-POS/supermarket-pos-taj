import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import { executeTool } from '@shared/lib/agent/tools/index';
import type { Staff } from '@shared/lib/domain';
import { useAgentStore } from './agentStore';
import { useAgent } from './useAgent';

vi.mock('@shared/lib/agent/tools/index', () => ({
  executeTool: vi.fn(),
}));

const mockedExecuteTool = vi.mocked(executeTool);

const SIGNED_IN_STAFF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function staffWith(role: Staff['role']): Staff {
  return {
    id: SIGNED_IN_STAFF_ID,
    name: 'Test Staff',
    role,
    isActive: true,
    mustChangePin: false,
    locale: 'en-US',
  };
}

describe('useAgent confirmImport', () => {
  beforeEach(() => {
    mockedExecuteTool.mockReset();
    useStaffStore.setState({
      currentStaff: staffWith('manager'),
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
    useAgentStore.setState({
      pendingImportProducts: [{ name: 'Widget', price: 9.99 }],
      isTyping: false,
    });
  });

  it('passes the signed-in staff id in the confirm_action telemetry context, not undefined', async () => {
    // bulk_import_products stages the import and returns a confirm_token;
    // confirmImport must then call confirm_action to actually write the rows.
    mockedExecuteTool.mockImplementation(async (name) => {
      if (name === 'bulk_import_products') {
        return { ok: true, data: { confirm_token: 'test-confirm-token' } };
      }
      return { ok: true, data: null };
    });

    const { result } = renderHook(() => useAgent());

    await act(async () => {
      await result.current.confirmImport();
    });

    await waitFor(() => {
      expect(mockedExecuteTool).toHaveBeenCalledWith(
        'confirm_action',
        { token: 'test-confirm-token' },
        expect.anything()
      );
    });

    const confirmActionCall = mockedExecuteTool.mock.calls.find(([name]) => name === 'confirm_action');
    expect(confirmActionCall).toBeDefined();
    const ctx = confirmActionCall?.[2];
    // Regression guard: every audit row this writes is now rejected by RLS
    // (WITH CHECK (user_id = auth.uid())) unless this carries the real staff id.
    expect(ctx?.userId).toBe(SIGNED_IN_STAFF_ID);
  });
});

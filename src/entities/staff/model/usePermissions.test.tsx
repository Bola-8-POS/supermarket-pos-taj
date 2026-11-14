import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRolePermissions } from '@entities/rbac';
import { useStaffStore } from './store';
import { usePermissions, usePermissionsSync } from './usePermissions';

vi.mock('@entities/rbac', () => ({
  useRolePermissions: vi.fn(),
}));

vi.mock('./store', () => ({
  useStaffStore: vi.fn(),
}));

type MockState = {
  currentStaff: { role: string } | null;
  permissions: string[] | null;
  managerGrantedActions: ReadonlySet<string>;
  setPermissions: (list: string[]) => void;
};

function mockStore(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    currentStaff: { role: 'cashier' },
    permissions: null,
    managerGrantedActions: new Set(),
    setPermissions: vi.fn(),
    ...overrides,
  };
  vi.mocked(useStaffStore).mockImplementation(selector => selector(state as never));
  return state;
}

function mockQuery(data: unknown, isError = false): void {
  vi.mocked(useRolePermissions).mockReturnValue({ data, isError } as never);
}

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('live wins over persisted', () => {
    mockStore({ permissions: ['close_tab'] });
    mockQuery({ ok: true, data: new Map([['cashier', new Set(['view_reports'])]]) });

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('view_reports')).toBe(true);
    expect(result.current.can('close_tab')).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it('persisted used while the query has no data', () => {
    mockStore({ permissions: ['close_tab'] });
    mockQuery(undefined);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(true);
    expect(result.current.ready).toBe(true);
  });

  it('{ok:false} result -> persisted used', () => {
    mockStore({ permissions: ['close_tab'] });
    mockQuery({ ok: false, error: { code: 'SUPABASE_ERROR', message: 'down' } });

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(true);
    expect(result.current.ready).toBe(true);
  });

  it('ok map without the role -> false (not the persisted list)', () => {
    mockStore({ permissions: ['close_tab'] });
    mockQuery({ ok: true, data: new Map([['manager', new Set(['close_tab'])]]) });

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it('both absent and query pending -> false and ready false', () => {
    mockStore({ permissions: null });
    mockQuery(undefined);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(false);
    expect(result.current.ready).toBe(false);
  });

  it('{ok:false} with nothing persisted -> ready true and can false', () => {
    mockStore({ permissions: null });
    mockQuery({ ok: false, error: { code: 'SUPABASE_ERROR', message: 'down' } });

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it('manager grant still ORs', () => {
    mockStore({ permissions: null, managerGrantedActions: new Set(['process_refund']) });
    mockQuery(undefined);

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('process_refund')).toBe(true);
  });

  it('no role -> false', () => {
    mockStore({ currentStaff: null, permissions: ['close_tab'] });
    mockQuery({ ok: true, data: new Map([['cashier', new Set(['close_tab'])]]) });

    const { result } = renderHook(() => usePermissions());

    expect(result.current.can('close_tab')).toBe(false);
    expect(result.current.ready).toBe(false);
  });

  describe('usePermissionsSync', () => {
    it('calls setPermissions with the live list, sorted', () => {
      const setPermissions = vi.fn();
      mockStore({ permissions: ['close_tab'], setPermissions });
      mockQuery({
        ok: true,
        data: new Map([['cashier', new Set(['view_reports', 'close_tab', 'create_order'])]]),
      });

      renderHook(() => {
        usePermissionsSync();
      });

      expect(setPermissions).toHaveBeenCalledWith(['close_tab', 'create_order', 'view_reports']);
    });

    it('does not call it when the contents are equal', () => {
      const setPermissions = vi.fn();
      mockStore({ permissions: ['close_tab', 'create_order', 'view_reports'], setPermissions });
      mockQuery({
        ok: true,
        data: new Map([['cashier', new Set(['view_reports', 'close_tab', 'create_order'])]]),
      });

      renderHook(() => {
        usePermissionsSync();
      });

      expect(setPermissions).not.toHaveBeenCalled();
    });
  });
});

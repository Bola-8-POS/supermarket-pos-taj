import { beforeEach, describe, expect, it } from 'vitest';
import type { Shift } from '@shared/lib/domain';
import { useStaffStore } from './store';
import { mockStaff } from './types';

const testShift: Shift = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  staffId: mockStaff[0]!.id,
  clockIn: new Date(),
  clockOut: null,
  openingCash: 0,
  closingCash: null,
};

describe('useStaffStore v0 -> v1 migration', () => {
  beforeEach(() => {
    localStorage.clear();
    useStaffStore.setState({ currentStaff: null, currentShift: null, isAuthenticated: false });
  });

  it('strips pin and email from a v0-persisted currentStaff on rehydrate', async () => {
    localStorage.setItem(
      'staff-store',
      JSON.stringify({
        state: {
          currentStaff: {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Alex Martinez',
            role: 'cashier',
            pin: 'x',
            email: 'y',
            isActive: true,
            mustChangePin: false,
            locale: 'es-MX',
          },
          currentShift: null,
          isAuthenticated: true,
        },
        version: 0,
      })
    );

    await useStaffStore.persist.rehydrate();

    const currentStaff = useStaffStore.getState().currentStaff as unknown as Record<
      string,
      unknown
    > | null;
    expect(currentStaff).not.toBeNull();
    expect(currentStaff).not.toHaveProperty('pin');
    expect(currentStaff).not.toHaveProperty('email');
    expect(currentStaff?.name).toBe('Alex Martinez');

    // Next state write persists the migrated (pin/email-free) shape.
    useStaffStore.setState({ currentShift: null });
    const persisted = JSON.parse(localStorage.getItem('staff-store') as string) as {
      state: { currentStaff: Record<string, unknown> | null };
    };
    expect(persisted.state.currentStaff).not.toHaveProperty('pin');
    expect(persisted.state.currentStaff).not.toHaveProperty('email');
  });
});

describe('useStaffStore v1 -> v2 migration', () => {
  beforeEach(() => {
    localStorage.clear();
    useStaffStore.setState({ currentStaff: null, currentShift: null, isAuthenticated: false });
  });

  it('sets permissions to null and keeps currentStaff/currentShift from a v1-persisted store', async () => {
    localStorage.setItem(
      'staff-store',
      JSON.stringify({
        state: {
          currentStaff: {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Alex Martinez',
            role: 'cashier',
            isActive: true,
            mustChangePin: false,
            locale: 'es-MX',
          },
          currentShift: {
            id: '22222222-2222-2222-2222-222222222222',
            staffId: '11111111-1111-1111-1111-111111111111',
          },
          isAuthenticated: true,
        },
        version: 1,
      })
    );

    await useStaffStore.persist.rehydrate();

    const state = useStaffStore.getState();
    expect(state.permissions).toBeNull();
    expect(state.currentStaff?.name).toBe('Alex Martinez');
    expect(state.currentShift?.id).toBe('22222222-2222-2222-2222-222222222222');
  });
});

describe('useStaffStore login() permission semantics', () => {
  beforeEach(() => {
    localStorage.clear();
    useStaffStore.setState({ currentStaff: null, currentShift: null, isAuthenticated: false });
  });

  it('an explicit list replaces the persisted list', () => {
    useStaffStore.getState().setPermissions(['close_tab']);

    useStaffStore.getState().login(mockStaff[0]!, testShift, ['view_reports']);

    expect(useStaffStore.getState().permissions).toEqual(['view_reports']);
  });

  it('a null argument with a different staff id resets to null', () => {
    useStaffStore.getState().login(mockStaff[0]!, testShift, ['view_reports']);

    useStaffStore.getState().login(mockStaff[1]!, testShift, null);

    expect(useStaffStore.getState().permissions).toBeNull();
  });

  it('a null argument with the same staff id keeps the persisted list', () => {
    useStaffStore.getState().login(mockStaff[0]!, testShift, ['view_reports']);

    useStaffStore.getState().login(mockStaff[0]!, testShift, null);

    expect(useStaffStore.getState().permissions).toEqual(['view_reports']);
  });
});

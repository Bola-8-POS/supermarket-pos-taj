import { beforeEach, describe, expect, it } from 'vitest';
import { useStaffStore } from './store';

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

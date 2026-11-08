import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOfflineUnlock } from './offlineUnlock';
import { useStaffStore } from './store';

vi.mock('./offlineUnlock', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearOfflineUnlock: vi.fn(),
}));

const staffRow = (role: string) => ({
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Alex Martinez',
  role,
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
});

function persist(version: number, role: string) {
  localStorage.setItem(
    'staff-store',
    JSON.stringify({
      state: {
        currentStaff: staffRow(role),
        currentShift: { id: '22222222-2222-2222-2222-222222222222' },
        isAuthenticated: true,
        permissions: ['create_order'],
      },
      version,
    })
  );
}

describe('useStaffStore v2 -> v3 migration (kitchen role retired)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(clearOfflineUnlock).mockClear();
    useStaffStore.setState({ currentStaff: null, currentShift: null, isAuthenticated: false, permissions: null, signOutPending: false });
  });

  it('a persisted v2 session with role kitchen rehydrates signed out', async () => {
    persist(2, 'kitchen');
    await useStaffStore.persist.rehydrate();

    const s = useStaffStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.currentStaff).toBeNull();
    expect(s.currentShift).toBeNull();
    expect(s.permissions).toBeNull();
    expect(s.signOutPending).toBe(true);
    expect(clearOfflineUnlock).toHaveBeenCalled();
  });

  it('a persisted v2 session with role cashier is kept with its permissions', async () => {
    persist(2, 'cashier');
    await useStaffStore.persist.rehydrate();

    const s = useStaffStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.currentStaff?.role).toBe('cashier');
    expect(s.permissions).toEqual(['create_order']);
    expect(s.signOutPending).toBe(false);
    expect(clearOfflineUnlock).not.toHaveBeenCalled();
  });

  it('a persisted v1 session still migrates as before', async () => {
    persist(1, 'cashier');
    await useStaffStore.persist.rehydrate();

    const s = useStaffStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.permissions).toBeNull();
    expect(s.currentStaff?.name).toBe('Alex Martinez');
  });
});

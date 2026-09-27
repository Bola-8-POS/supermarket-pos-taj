import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { Shift, Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { StaffDashboard } from './StaffDashboard';

const staffOpen: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Alex',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const staffClosed: Staff = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Jamie',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const openShift: Shift = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  staffId: staffOpen.id,
  clockIn: new Date('2026-04-17T09:00:00.000Z'),
  clockOut: null,
  openingCash: 100,
  closingCash: null,
};

const useStaffList = vi.fn();
const useOpenShifts = vi.fn();
const usePermissions = vi.fn();

vi.mock('@entities/staff', () => ({
  useStaffList: () => useStaffList(),
  useOpenShifts: () => useOpenShifts(),
  usePermissions: () => usePermissions(),
}));

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

describe('StaffDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStaffList.mockReturnValue({
      data: [staffOpen, staffClosed],
      isIdleOrLoading: false,
      isEmpty: false,
    });
    useOpenShifts.mockReturnValue({
      data: [openShift],
      isIdleOrLoading: false,
    });
    usePermissions.mockReturnValue({
      can: (action: string) => action === 'manage_staff',
    });
    useStaffStore.setState({
      currentStaff: { ...staffClosed },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
  });

  it('renders staff rows and clock actions', () => {
    renderWithProviders(<MemoryRouter><StaffDashboard /></MemoryRouter>);
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock Out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock In' })).toBeInTheDocument();
  });

  it('scopes the roster to the current staff member when role is cashier', () => {
    useStaffStore.setState({
      currentStaff: { ...staffOpen },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });

    renderWithProviders(<MemoryRouter><StaffDashboard /></MemoryRouter>);

    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.queryByText('Jamie')).not.toBeInTheDocument();
  });

  it('renders a "Force PIN Change" action per staff row', () => {
    renderWithProviders(<MemoryRouter><StaffDashboard /></MemoryRouter>);
    expect(screen.getAllByRole('button', { name: 'Force PIN Change' }).length).toBe(2);
  });

  it('renders a "Deactivate" action for every row except the signed-in staff member', () => {
    // currentStaff is Jamie (staffClosed): only Alex's row gets the action.
    renderWithProviders(<MemoryRouter><StaffDashboard /></MemoryRouter>);
    const buttons = screen.getAllByRole('button', { name: 'Deactivate' });
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.closest('tr')).toBe(screen.getByText('Alex').closest('tr'));
  });

  it('shows loading state when queries pending', () => {
    useStaffList.mockReturnValue({ data: undefined, isIdleOrLoading: true });
    useOpenShifts.mockReturnValue({ data: undefined, isIdleOrLoading: true });

    renderWithProviders(<MemoryRouter><StaffDashboard /></MemoryRouter>);
    expect(screen.getByPlaceholderText('Search staff…')).toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: 'Loading...' }).length).toBeGreaterThan(0);
  });

  it('highlights the staff row matching ?id=', () => {
    renderWithProviders(
      <MemoryRouter initialEntries={[`/staff?id=${staffOpen.id}`]}>
        <StaffDashboard />
      </MemoryRouter>
    );

    const highlightedRow = screen.getByText('Alex').closest('tr');
    const otherRow = screen.getByText('Jamie').closest('tr');
    expect(highlightedRow?.className).toContain('bg-accent/40');
    expect(otherRow?.className).not.toContain('bg-accent/40');
  });

  it.todo('does not render an element with text "Administration" for admin users');
  it.todo('does not render an "Edit Role" button anywhere in the component');
  it.todo('does not render an "Add Staff" button anywhere in the component');
});

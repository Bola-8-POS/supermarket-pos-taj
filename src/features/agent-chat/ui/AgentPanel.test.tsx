import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { AgentPanel } from './AgentPanel';

function staffWith(role: Staff['role']): Staff {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Test Staff',
    role,
    isActive: true,
    mustChangePin: false,
    locale: 'en-US',
  };
}

describe('AgentPanel role gate', () => {
  beforeEach(() => {
    useStaffStore.setState({
      currentStaff: null,
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
  });

  it('does not render for a cashier', () => {
    useStaffStore.setState({ currentStaff: staffWith('cashier') });
    const { container } = renderWithProviders(<AgentPanel />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not render for kitchen staff', () => {
    useStaffStore.setState({ currentStaff: staffWith('kitchen') });
    const { container } = renderWithProviders(<AgentPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders for a manager', () => {
    useStaffStore.setState({ currentStaff: staffWith('manager') });
    renderWithProviders(<AgentPanel />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders for an admin', () => {
    useStaffStore.setState({ currentStaff: staffWith('admin') });
    renderWithProviders(<AgentPanel />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

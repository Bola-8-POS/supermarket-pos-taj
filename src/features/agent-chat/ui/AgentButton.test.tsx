import { beforeEach, describe, expect, it } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { AgentButton } from './AgentButton';

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

describe('AgentButton role gate', () => {
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
    const { container } = renderWithProviders(<AgentButton />);
    expect(container.firstChild).toBeNull();
  });

  it('does not render for kitchen staff', () => {
    useStaffStore.setState({ currentStaff: staffWith('kitchen') });
    const { container } = renderWithProviders(<AgentButton />);
    expect(container.firstChild).toBeNull();
  });

  it('renders for a manager', () => {
    useStaffStore.setState({ currentStaff: staffWith('manager') });
    const { container } = renderWithProviders(<AgentButton />);
    expect(container.firstChild).not.toBeNull();
  });

  it('renders for an admin', () => {
    useStaffStore.setState({ currentStaff: staffWith('admin') });
    const { container } = renderWithProviders(<AgentButton />);
    expect(container.firstChild).not.toBeNull();
  });
});

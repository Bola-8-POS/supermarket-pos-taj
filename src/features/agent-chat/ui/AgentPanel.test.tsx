import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import type * as FeaturesModule from '@shared/lib/license/features';
import { renderWithProviders } from '@shared/lib/test-utils';
import { AgentPanel } from './AgentPanel';

const featureState = { enabled: true };
vi.mock('@shared/lib/license/features', async importOriginal => {
  const actual = await importOriginal<typeof FeaturesModule>();
  return {
    ...actual,
    useFeature: () => ({
      enabled: featureState.enabled,
      locked: !featureState.enabled,
      requestUpgrade: vi.fn(),
    }),
  };
});

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
    featureState.enabled = true;
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

  it('does not render for an admin when the license lacks ai_assistant (hidden, not just locked)', () => {
    featureState.enabled = false;
    useStaffStore.setState({ currentStaff: staffWith('admin') });
    const { container } = renderWithProviders(<AgentPanel />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

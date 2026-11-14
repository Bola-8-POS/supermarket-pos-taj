import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { AssistantStatus, Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { AssistantButton } from './AssistantButton';

const status: { data: AssistantStatus | undefined } = { data: undefined };
vi.mock('../model/useAssistantStatus', () => ({ useAssistantStatus: () => status }));
vi.mock('@shared/lib/license/features', async importOriginal => ({
  ...(await importOriginal<object>()),
  useFeature: () => ({ enabled: true, locked: false, requestUpgrade: vi.fn() }),
}));

const staffWith = (role: Staff['role']): Staff => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Test Staff',
  role,
  isActive: true,
  mustChangePin: false,
  locale: 'en-US',
});
const state = (s: AssistantStatus['state']): AssistantStatus => ({
  state: s,
  reason: null,
  modelId: null,
  runtimeTag: null,
});

describe('AssistantButton', () => {
  beforeEach(() => {
    status.data = undefined;
    useStaffStore.setState({ currentStaff: staffWith('cashier'), isAuthenticated: true });
  });

  it.each(['not_installed', 'starting', 'unavailable'] as const)('is hidden when the status is %s', s => {
    status.data = state(s);
    expect(renderWithProviders(<AssistantButton />).container.firstChild).toBeNull();
  });

  it('is hidden while the status has not loaded', () => {
    expect(renderWithProviders(<AssistantButton />).container.firstChild).toBeNull();
  });

  it.each(['cashier', 'manager', 'admin'] as const)('renders for a %s when ready', role => {
    status.data = state('ready');
    useStaffStore.setState({ currentStaff: staffWith(role) });
    const { getByRole } = renderWithProviders(<AssistantButton />);
    expect(getByRole('button', { name: 'Open assistant' })).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditRoleDialog } from './EditRoleDialog';

vi.mock('@shared/ui/select', () => ({
  Select: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-select-value={value}>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectItem: ({ value, className }: { value: string; className?: string }) => (
    <div data-testid="opt" data-value={value} data-cls={className} />
  ),
}));
vi.mock('@entities/staff/model/queries', () => ({
  useMutationUpdateStaffRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@shared/ui/LockedFeature', () => ({ LockedFeature: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

describe('EditRoleDialog', () => {
  it('the role picker offers cashier, manager and admin only', () => {
    render(
      <EditRoleDialog open onOpenChange={vi.fn()} staff={[]} currentStaffId={null} preSelectedStaffId={undefined} />
    );
    const roles = screen
      .getAllByTestId('opt')
      .filter(o => o.getAttribute('data-cls') === 'capitalize')
      .map(o => o.getAttribute('data-value'));
    expect([...roles].sort()).toEqual(['admin', 'cashier', 'manager']);
  });
});

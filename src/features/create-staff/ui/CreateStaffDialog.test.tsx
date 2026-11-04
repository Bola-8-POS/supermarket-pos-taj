import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CreateStaffDialog } from './CreateStaffDialog';

// Radix Select portals need pointer APIs jsdom lacks; flatten it so the options are inspectable.
vi.mock('@shared/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectItem: ({ value }: { value: string }) => <div data-testid="opt" data-value={value} />,
}));
vi.mock('../model/useCreateStaff', () => ({ useCreateStaff: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('@shared/ui/LockedFeature', () => ({ LockedFeature: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

describe('CreateStaffDialog', () => {
  it('the role picker offers cashier, manager and admin only', () => {
    render(<CreateStaffDialog open onOpenChange={vi.fn()} />);
    const values = screen.getAllByTestId('opt').map(o => o.getAttribute('data-value'));
    const roles = values.filter(v => v !== 'es-MX' && v !== 'en-US');
    expect([...roles].sort()).toEqual(['admin', 'cashier', 'manager']);
  });
});

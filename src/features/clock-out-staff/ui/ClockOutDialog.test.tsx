import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shift, Staff } from '@shared/lib/domain';
import { ClockOutDialog } from './ClockOutDialog';

const staff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Pat',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const shift: Shift = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  staffId: staff.id,
  clockIn: new Date('2026-04-17T08:00:00.000Z'),
  clockOut: null,
  openingCash: 50,
  closingCash: null,
};

const mutateAsync = vi.fn();

vi.mock('@entities/staff/model/queries', () => ({
  useMutationClockOut: () => ({
    mutateAsync,
    isPending: false,
  }),
  useShiftClosePreview: () => ({
    data: { orderCount: 3, totalSales: 150.5, shiftStartedAt: shift.clockIn },
    resultError: undefined,
    isIdleOrLoading: false,
    isSuccess: true,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('ClockOutDialog', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({
      ok: true,
      data: { ...shift, clockOut: new Date(), closingCash: 100 },
    });
  });

  it('does not show confirm when staff or shift missing', () => {
    render(<ClockOutDialog open onOpenChange={vi.fn()} staff={null} shift={null} />, {
      wrapper,
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows preview summary and completes clock out', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<ClockOutDialog open onOpenChange={onOpenChange} staff={staff} shift={shift} />, {
      wrapper,
    });

    expect(screen.getByText('Orders taken')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clock out' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        shiftId: shift.id,
        staffId: staff.id,
        closingCash: 0,
      });
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts error when clock out fails', async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'Update failed' },
    });

    render(<ClockOutDialog open onOpenChange={vi.fn()} staff={staff} shift={shift} />, {
      wrapper,
    });

    await user.click(screen.getByRole('button', { name: 'Clock out' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Update failed');
    });
  });
});

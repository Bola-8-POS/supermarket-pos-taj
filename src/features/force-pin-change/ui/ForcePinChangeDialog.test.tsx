import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { supabase } from '@shared/lib/supabase';
import { renderWithProviders } from '@shared/lib/test-utils';

import { ForcePinChangeDialog } from './ForcePinChangeDialog';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase.rpc);

const mockStaff = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Jamie Chen',
  email: 'jamie@barpos.dev',
  role: 'cashier' as const,
  pin: '123456',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};

describe('ForcePinChangeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);
  });

  function renderDialog(
    overrides: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      staff?: typeof mockStaff | null;
    } = {}
  ) {
    const onOpenChange = overrides.onOpenChange ?? vi.fn();
    renderWithProviders(
      <ForcePinChangeDialog
        staff={overrides.staff === undefined ? mockStaff : overrides.staff}
        open={overrides.open ?? true}
        onOpenChange={onOpenChange}
      />
    );
    return { onOpenChange };
  }

  it('renders the exact title, body copy, and confirm button label', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Force PIN change for Jamie Chen?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Jamie Chen will be required to set a new PIN before they can log in again. This does not log them out of an active shift.'
      )
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Force PIN change' })).toBeInTheDocument();
  });

  it('does not render when staff is null', () => {
    renderDialog({ staff: null });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('clicking confirm calls the force_pin_change RPC with the staff id and fires the success toast', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Force PIN change' }));

    await waitFor(() => {
      expect(mockedRpc).toHaveBeenCalledWith('force_pin_change', {
        p_staff_id: mockStaff.id,
        p_terminal_id: expect.any(String) as unknown as string,
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Jamie Chen's PIN will be changed on next login.");
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows an error toast when the RPC fails', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'AUTH_FORBIDDEN' },
    } as never);

    const user = userEvent.setup();
    renderDialog();

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Force PIN change' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });
});

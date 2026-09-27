import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CorrectOpenUnitDialog } from './CorrectOpenUnitDialog';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockMutateAsync = vi.fn();
vi.mock('@entities/open-unit', () => ({
  useMutationCorrectOpenUnit: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

// Stub exposing a "grant" control instead of the real PIN keypad — lets the
// ordering assertion (no dispatch before PIN success) be tested directly
// without a real staff-list fetch.
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    requiredAction: string;
    onSuccess: () => void;
  }) =>
    props.open
      ? createElement(
          'button',
          { onClick: props.onSuccess, 'data-required-action': props.requiredAction },
          'Grant PIN'
        )
      : null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function renderDialog(props: Partial<Parameters<typeof CorrectOpenUnitDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const defaultProps = {
    openUnitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    productName: 'Marlboro',
    currentCount: 20,
    unitsPerPackage: 20,
    open: true,
    onOpenChange,
    ...props,
  };
  render(createElement(CorrectOpenUnitDialog, defaultProps));
  return { onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CorrectOpenUnitDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog title with the product name', () => {
    renderDialog();
    expect(screen.getByText(/Marlboro/i)).toBeInTheDocument();
  });

  it('disables the confirm button while the reason input is empty', () => {
    renderDialog();
    const btn = screen.getByRole('button', { name: /correct|corregir/i });
    expect(btn).toBeDisabled();
  });

  it('keeps the confirm button disabled for a whitespace-only reason', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), '   ');

    expect(screen.getByRole('button', { name: /correct|corregir/i })).toBeDisabled();
  });

  it('disables the confirm button and shows an inline error for an out-of-range count', async () => {
    const user = userEvent.setup();
    renderDialog({ unitsPerPackage: 20, currentCount: 20 });

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted');
    const countInput = screen.getByRole('spinbutton');
    await user.clear(countInput);
    await user.type(countInput, '25');

    expect(screen.getByRole('button', { name: /correct|corregir/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('enables the confirm button once a non-blank reason and an in-range count are both present', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');

    expect(screen.getByRole('button', { name: /correct|corregir/i })).toBeEnabled();
  });

  it('does not dispatch the mutation on submit — opens the manager PIN dialog first', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');
    fireEvent.click(screen.getByRole('button', { name: /correct|corregir/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/grant pin/i)).toBeInTheDocument();
  });

  it('requests the manager PIN with requiredAction="adjust_inventory"', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');
    fireEvent.click(screen.getByRole('button', { name: /correct|corregir/i }));

    expect(screen.getByText(/grant pin/i)).toHaveAttribute(
      'data-required-action',
      'adjust_inventory'
    );
  });

  it('dispatches the mutation only after the PIN dialog reports success', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ ok: true, data: undefined });
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');
    fireEvent.click(screen.getByRole('button', { name: /correct|corregir/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/grant pin/i));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        openUnitId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        remainingCount: 20,
        reason: 'Recounted — 2 missing',
      });
    });
  });

  it('closes the dialog and toasts success after a successful correction', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ ok: true, data: undefined });
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');
    fireEvent.click(screen.getByRole('button', { name: /correct|corregir/i }));
    fireEvent.click(screen.getByText(/grant pin/i));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('surfaces the RPC error message verbatim on mutation failure, without closing the dialog', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'remaining count 25 is out of range 0..20' },
    });
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Recounted — 2 missing');
    fireEvent.click(screen.getByRole('button', { name: /correct|corregir/i }));
    fireEvent.click(screen.getByText(/grant pin/i));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('remaining count 25 is out of range 0..20');
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

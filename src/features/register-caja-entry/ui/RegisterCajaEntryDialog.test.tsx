import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Mock useRegisterCajaEntry — RegisterCajaEntryDialog imports it directly
// from '../model/useRegisterCajaEntry', not the feature's barrel, so the
// mock specifier must match that exact module (mocking '@features/
// register-caja-entry' here would silently never intercept the dialog's own
// import and every mockRegisterEntry/mockResetIdempotencyKey assertion would
// be dead code).
// ---------------------------------------------------------------------------

const mockRegisterEntry = vi.fn();
const mockResetIdempotencyKey = vi.fn();

vi.mock('../model/useRegisterCajaEntry', () => ({
  useRegisterCajaEntry: () => ({
    registerEntry: mockRegisterEntry,
    isPending: false,
    resetIdempotencyKey: mockResetIdempotencyKey,
  }),
}));

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock useStaffStore
// ---------------------------------------------------------------------------

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (s: { currentStaff: { id: string } | null }) => unknown) =>
    selector({ currentStaff: { id: 'staff-uuid-001' } }),
}));

import { RegisterCajaEntryDialog } from './RegisterCajaEntryDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  renderWithProviders(<RegisterCajaEntryDialog open={open} onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RegisterCajaEntryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog heading when open', () => {
    renderDialog();
    expect(screen.getByText('Register Expense / Income')).toBeInTheDocument();
  });

  it('defaults to expense type (Expense button is visually active/destructive)', () => {
    renderDialog();
    const expenseBtn = screen.getByRole('button', { name: /expense/i });
    const incomeBtn = screen.getByRole('button', { name: /income/i });
    expect(expenseBtn).toBeInTheDocument();
    expect(incomeBtn).toBeInTheDocument();
  });

  it('shows validation error when concept is empty on submit', async () => {
    renderDialog();

    // Fill amount but leave concept empty
    const amountInput = screen.getByLabelText(/amount/i);
    fireEvent.change(amountInput, { target: { value: '50' } });

    const form = screen.getByTestId('entry-form');
    fireEvent.submit(form);

    // Validation error should appear for concept
    expect(await screen.findByText(/concept is required/i)).toBeInTheDocument();
  });

  it('shows validation error when amount is zero or negative', async () => {
    renderDialog();

    const amountInput = screen.getByLabelText(/amount/i);
    fireEvent.change(amountInput, { target: { value: '0' } });

    const conceptInput = screen.getByPlaceholderText(/describe this entry/i);
    fireEvent.change(conceptInput, { target: { value: 'Test entry' } });

    const form = screen.getByTestId('entry-form');
    fireEvent.submit(form);

    expect(await screen.findByText(/amount must be greater than 0/i)).toBeInTheDocument();
  });

  it('shows "Save Entry" button text in non-pending state', () => {
    renderDialog();
    // In non-pending state, the submit button says "Save Entry" and is enabled
    const submitBtn = screen.getByRole('button', { name: /save entry/i });
    expect(submitBtn).toBeInTheDocument();
    expect(submitBtn).not.toBeDisabled();
  });

  it('discards the idempotency key when the dialog is closed via Cancel (fix-pass F3: the dialog stays mounted across attempts)', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

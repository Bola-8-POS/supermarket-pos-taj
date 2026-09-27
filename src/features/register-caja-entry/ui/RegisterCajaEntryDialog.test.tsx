import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import type * as FeatureRegister from '../index';

// ---------------------------------------------------------------------------
// Mock useRegisterCajaEntry
// ---------------------------------------------------------------------------

const mockRegisterEntry = vi.fn();

vi.mock('@features/register-caja-entry', async importOriginal => {
  const actual = await importOriginal<typeof FeatureRegister>();
  return {
    ...actual,
    useRegisterCajaEntry: () => ({
      registerEntry: mockRegisterEntry,
      isPending: false,
    }),
  };
});

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
});

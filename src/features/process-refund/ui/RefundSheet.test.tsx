import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Mock useProcessRefund — RefundSheet imports it directly from
// '../model/useProcessRefund' (not the feature barrel), so the mock
// specifier must match that exact module (the same mock-path bug fixed in
// RegisterCajaEntryDialog.test.tsx during F3 round 1 — mocking the barrel
// here would silently never intercept RefundSheet's own import).
// ---------------------------------------------------------------------------

const mockMutateAsync = vi.fn();
const mockResetIdempotencyKey = vi.fn();

vi.mock('../model/useProcessRefund', () => ({
  useProcessRefund: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    resetIdempotencyKey: mockResetIdempotencyKey,
  }),
}));

const mockOrderItems = [
  { id: 'item-1', products: { name: 'Widget' }, unit_price: 10, qty: 2 },
];

vi.mock('@entities/payment', () => ({
  useOrderItemsByPayment: () => ({ data: mockOrderItems, isLoading: false }),
}));

vi.mock('@entities/refund', () => ({
  useRefundsByPayment: () => ({ data: [] }),
}));

// Ignores the `open` prop and always renders a confirm button — real
// ManagerPinDialog only renders its content when open, but that gating isn't
// what these tests exercise; they need a way to trigger onSuccess directly.
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({
    onSuccess,
  }: {
    onSuccess: (staff: { id: string }, approvalId: string) => void;
  }) => (
    <button onClick={() => { onSuccess({ id: 'staff-1' }, 'approval-1'); }}>Confirm PIN</button>
  ),
}));

import { RefundSheet } from './RefundSheet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSheet(open = true) {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <RefundSheet open={open} paymentId="payment-uuid-001" onOpenChange={onOpenChange} />
  );
  return { onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RefundSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the sheet heading when open', () => {
    renderSheet();
    expect(screen.getByText('Process refund')).toBeInTheDocument();
  });

  it('discards the idempotency key when the sheet is closed via the Close button (fix-pass F3: RefundSheet stays mounted across different payments)', () => {
    const { onOpenChange } = renderSheet();

    fireEvent.click(screen.getByRole('button', { name: /close refund/i }));

    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // F4 follow-up on F3: the success path in handleSubmitRefund called the raw
  // onOpenChange prop instead of handleOpenChange, so a successful refund
  // left the selected item checked and the reason set — a duplicate partial
  // refund was then one tap plus a PIN away.
  it('clears the selected items and discards the idempotency key after a successful refund', async () => {
    mockMutateAsync.mockResolvedValueOnce({ ok: true, data: 'refund-id-123' });
    const { onOpenChange } = renderSheet();

    const checkbox = screen.getByRole('checkbox', { name: /select widget for refund/i });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    // getByText, not getByRole: the real Sheet is a Radix Dialog, and while
    // it's open Radix marks sibling DOM content aria-hidden to trap focus —
    // the mocked ManagerPinDialog's button is that sibling content, so
    // getByRole('button', ...) can't see it even though it's clickable.
    fireEvent.click(screen.getByText('Confirm PIN'));

    await waitFor(() => {
      expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // handleOpenChange's setOverrides(new Map()) took effect: the item row
    // re-renders unchecked, proving the form actually reset (not just the
    // key) — this is what the raw onOpenChange call used to skip.
    expect(
      screen.getByRole('checkbox', { name: /select widget for refund/i })
    ).toHaveAttribute('aria-checked', 'false');
  });
});

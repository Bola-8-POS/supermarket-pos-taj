import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Mock useEditPaidTab — EditPaidTabDialog imports it directly from
// '../model/useEditPaidTab' (not the feature barrel), so the mock specifier
// must match that exact module (the same mock-path bug fixed in
// RegisterCajaEntryDialog.test.tsx during F3 round 1 — mocking the barrel
// here would silently never intercept EditPaidTabDialog's own import).
// ---------------------------------------------------------------------------

const mockMutateAsync = vi.fn();
const mockResetIdempotencyKey = vi.fn();

vi.mock('../model/useEditPaidTab', () => ({
  useEditPaidTab: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    resetIdempotencyKey: mockResetIdempotencyKey,
  }),
}));

vi.mock('@entities/tab', () => ({
  useTab: () => ({
    data: { id: 'tab-uuid-001', customerName: 'Test Customer', version: 1, items: [], notes: null },
    isLoading: false,
  }),
  tabKeys: { detail: (id: string) => ['tabs', 'detail', id] },
}));

vi.mock('@entities/product', () => ({
  useProducts: () => ({ data: [] }),
}));

vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: () => null,
}));

import { EditPaidTabDialog } from './EditPaidTabDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <EditPaidTabDialog open={open} tabId="tab-uuid-001" onOpenChange={onOpenChange} />
  );
  return { onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditPaidTabDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the sheet heading when open', () => {
    renderDialog();
    expect(screen.getByText('Edit paid ticket')).toBeInTheDocument();
  });

  it('discards the idempotency key when the sheet is closed via Cancel (fix-pass F4: EditPaidTabDialog stays mounted across different tabs, and Cancel used to call the raw onOpenChange prop, skipping this)', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

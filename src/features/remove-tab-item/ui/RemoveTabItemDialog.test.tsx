import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderItem } from '@shared/lib/domain';

import { RemoveTabItemDialog } from './RemoveTabItemDialog';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the mutation hook used inside the dialog
const mockRemoveTabItem = vi.fn();
vi.mock('../useRemoveTabItem', () => ({
  useRemoveTabItem: () => ({
    removeTabItem: mockRemoveTabItem,
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseItem: OrderItem = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  productId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  quantity: 2,
  unitPrice: 45,
  modifierIds: [],
  modifierPriceDelta: 0,
  notes: null,
  modifiers: [],
  product: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'Cerveza Artesanal',
    categoryId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    basePrice: 45,
    happyHourPrice: null,
    sku: null,
    isActive: true,
    soldByWeight: false,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    comboEligible: true,
    isCombo: false,
    modifiers: [],
  },
};

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function renderDialog(props: Partial<Parameters<typeof RemoveTabItemDialog>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const defaultProps = {
    open: true,
    item: baseItem,
    tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    onClose,
    ...props,
  };

  render(createElement(RemoveTabItemDialog, defaultProps), {
    wrapper: makeWrapper(queryClient),
  });

  return { onClose, queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoveTabItemDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when item is null', () => {
    renderDialog({ item: null });
    expect(screen.queryByText('Remove item?')).not.toBeInTheDocument();
  });

  it('renders item name and quantity when open and item provided', () => {
    renderDialog();
    expect(screen.getByText(/Cerveza Artesanal/i)).toBeInTheDocument();
    expect(screen.getByText(/2x/i)).toBeInTheDocument();
  });

  it('renders a destructive confirm button labelled "Remove item"', () => {
    renderDialog();
    const btn = screen.getByRole('button', { name: /remove item/i });
    expect(btn).toBeInTheDocument();
  });

  it('disables the confirm button while the reason input is empty', () => {
    renderDialog();
    const btn = screen.getByRole('button', { name: /remove item/i });
    expect(btn).toBeDisabled();
  });

  it('keeps the confirm button disabled for a whitespace-only reason', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), '   ');

    expect(screen.getByRole('button', { name: /remove item/i })).toBeDisabled();
  });

  it('enables the confirm button once a non-empty reason is typed', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Wrong item');

    expect(screen.getByRole('button', { name: /remove item/i })).toBeEnabled();
  });

  it('calls removeTabItem mutation with the trimmed reason when confirm button is clicked', async () => {
    const user = userEvent.setup();
    mockRemoveTabItem.mockResolvedValue({ ok: true, data: undefined });
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), '  Wrong item  ');
    fireEvent.click(screen.getByRole('button', { name: /remove item/i }));

    await waitFor(() => {
      expect(mockRemoveTabItem).toHaveBeenCalledWith({
        tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        itemId: baseItem.id,
        productId: baseItem.productId,
        quantity: baseItem.quantity,
        reason: 'Wrong item',
      });
    });
  });

  it('calls onClose after successful mutation', async () => {
    const user = userEvent.setup();
    mockRemoveTabItem.mockResolvedValue({ ok: true, data: undefined });
    const { onClose } = renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Wrong item');
    fireEvent.click(screen.getByRole('button', { name: /remove item/i }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows error toast when mutation fails', async () => {
    const user = userEvent.setup();
    mockRemoveTabItem.mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'DB error' },
    });
    renderDialog();

    await user.type(screen.getByLabelText(/motivo|reason/i), 'Wrong item');
    fireEvent.click(screen.getByRole('button', { name: /remove item/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('DB error');
    });
    // Verify success toast was never called (dialog did not close on the happy path)
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders no PIN dialog / manager-gate elements', () => {
    renderDialog();
    expect(screen.queryByText(/pin/i)).not.toBeInTheDocument();
  });

  it('dialog is hidden (returns null) when open=false and item=null', () => {
    renderDialog({ open: false, item: null });
    expect(screen.queryByText('Remove item?')).not.toBeInTheDocument();
  });
});

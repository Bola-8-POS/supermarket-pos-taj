/**
 * Unit tests for PhysicalCountForm's handling of usePhysicalCount's
 * `reportedRows` (wave 3a, Task 2 fix round 1).
 *
 * When a submitted count contains rows the server rejected with
 * STOCK_CHANGED, the overall Result is still ok:true (only a non-STOCK_CHANGED
 * failure returns err), so the form must not show its "no variances" or
 * plain "N adjusted" success toast — it must show a dedicated message, and
 * when *every* changed row was reported (nothing applied), the count is not
 * complete: the form stays on the entry screen instead of advancing to the
 * variance report, and the counts the person typed are left untouched.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inventory, Staff } from '@shared/lib/domain';
import { ok } from '@shared/lib/result';
import { PhysicalCountForm } from './PhysicalCountForm';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const staff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Pat',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'en-US',
};

const productA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeInventoryItem(productId: string, name: string, qty: number): Inventory {
  return {
    id: crypto.randomUUID(),
    productId,
    quantityOnHand: qty,
    lowStockThreshold: 5,
    unit: 'unit',
    product: {
      id: productId,
      name,
      categoryId: crypto.randomUUID(),
      basePrice: 100,
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
}

const inventory: Inventory[] = [
  makeInventoryItem(productA, 'Rice', 10),
  makeInventoryItem(productB, 'Beans', 8),
];

function makeRow(productId: string, productName: string, actualCount: number, expectedStock: number) {
  return {
    productId,
    productName,
    expectedStock,
    actualCount,
    variance: actualCount - expectedStock,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@entities/inventory', () => ({
  useInventory: () => ({ data: inventory, isIdleOrLoading: false }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (s: { currentStaff: Staff }) => unknown) =>
    selector({ currentStaff: staff }),
}));

const mockSubmit = vi.fn();
vi.mock('../model/usePhysicalCount', () => ({
  usePhysicalCount: () => ({
    submitPhysicalCount: mockSubmit,
    isPending: false,
    reset: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

async function setCount(productId: string, value: number) {
  const row = screen.getByTestId(`physical-count-row-${productId}`);
  const input = within(row).getByRole('spinbutton');
  fireEvent.change(input, { target: { value: String(value) } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhysicalCountForm — reportedRows handling', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it('one adjusted plus one reported row: shows the dedicated message and still advances to the report', async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue(
      ok({
        adjustedRows: [makeRow(productA, 'Rice', 7, 10)],
        allRows: [makeRow(productA, 'Rice', 7, 10), makeRow(productB, 'Beans', 5, 8)],
        reportedRows: [makeRow(productB, 'Beans', 5, 8)],
      })
    );

    render(<PhysicalCountForm open onOpenChange={vi.fn()} />, {
      wrapper: makeWrapper(queryClient),
    });

    await setCount(productA, 7);
    await setCount(productB, 5);
    await user.click(screen.getByTestId('physical-count-submit'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('changed underneath the count and were not applied')
      );
    });
    expect(toast.success).not.toHaveBeenCalled();

    // Some rows did apply — the form still advances to the variance report.
    await waitFor(() => {
      expect(screen.getByText(/Review the variance report/i)).toBeInTheDocument();
    });
  });

  it('all changed rows reported: shows the dedicated message, stays on the count, and does not reset it', async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue(
      ok({
        adjustedRows: [],
        allRows: [makeRow(productA, 'Rice', 7, 10), makeRow(productB, 'Beans', 5, 8)],
        reportedRows: [makeRow(productA, 'Rice', 7, 10), makeRow(productB, 'Beans', 5, 8)],
      })
    );

    render(<PhysicalCountForm open onOpenChange={vi.fn()} />, {
      wrapper: makeWrapper(queryClient),
    });

    await setCount(productA, 7);
    await user.click(screen.getByTestId('physical-count-submit'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('changed underneath the count and were not applied')
      );
    });
    expect(toast.success).not.toHaveBeenCalled();

    // Not completed — still on the entry screen (submit button present, the
    // report-only description is not), and the typed count survives.
    expect(screen.getByTestId('physical-count-submit')).toBeInTheDocument();
    expect(screen.queryByText(/Review the variance report/i)).not.toBeInTheDocument();
    const row = screen.getByTestId(`physical-count-row-${productA}`);
    expect(within(row).getByRole('spinbutton')).toHaveValue(7);
  });
});

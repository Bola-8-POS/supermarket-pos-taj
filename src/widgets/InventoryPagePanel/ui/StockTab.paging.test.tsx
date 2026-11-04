/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import type { ColumnDef } from '@tanstack/react-table';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import '@shared/lib/i18n';
import type { Inventory } from '@shared/lib/domain';
import { StockTab } from './StockTab';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = (n: number) => `Item ${String(n).padStart(3, '0')}`;

// 120 rows: every 3rd is out of stock, every 3rd+1 is low stock.
const rows = Array.from({ length: 120 }, (_, i) => {
  const quantityOnHand = i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 50;
  return {
    id: uuid(i + 1),
    productId: uuid(i + 1001),
    quantityOnHand,
    lowStockThreshold: 5,
    costPrice: 2,
    unit: 'pc',
    product: { name: name(i), sku: `SKU${i}`, barcode: `BC${i}`, category: { name: 'Cat' } },
  } as unknown as Inventory;
});

const columns: ColumnDef<Inventory>[] = [
  {
    id: 'productName',
    accessorFn: r => r.product?.name ?? '',
    header: ({ column }) => (
      <button type="button" onClick={column.getToggleSortingHandler()}>
        NameCol
      </button>
    ),
  },
];

vi.mock('@entities/inventory', () => ({
  inventoryRowColumns: () => columns,
  stockValue: (qty: number, cost: number) => qty * cost,
  useInventory: () => ({ data: rows, isLoading: false, resultError: undefined, isEmpty: false }),
  useNearExpiryAlerts: () => ({ data: [] }),
  useMutationAdjustInventory: () => ({
    mutateAsync: vi.fn(),
    resetIdempotencyKey: vi.fn(),
    isPending: false,
  }),
}));
vi.mock('@entities/staff', () => ({
  ProtectedAction: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (select: (s: { currentStaff: { id: string } }) => unknown) =>
    select({ currentStaff: { id: 's1' } }),
}));
vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

function renderTab() {
  render(
    <MemoryRouter>
      <StockTab onOpenCatalog={undefined} />
    </MemoryRouter>
  );
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');

describe('StockTab paging', () => {
  it('renders one page of 120 stock rows', () => {
    renderTab();
    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
  });

  it('the low-stock filter and search cover rows beyond the first page', async () => {
    renderTab();
    // Item 119 sits on page 3 of the unfiltered list.
    await userEvent.type(screen.getByPlaceholderText('Search product, SKU or barcode…'), 'SKU119');
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    await userEvent.clear(screen.getByPlaceholderText('Search product, SKU or barcode…'));
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(50);
    });
    await userEvent.click(screen.getByRole('button', { name: /low stock/i }));
    // 40 low rows (i % 3 === 1) fit one page: all reachable, no pager.
    expect(bodyRows()).toHaveLength(40);
    expect(screen.queryByText(/^Page \d+ of/)).toBeNull();
  });

  it('header sort orders all rows before paging', async () => {
    renderTab();
    const sortBtn = screen.getByRole('button', { name: 'NameCol' });
    await userEvent.click(sortBtn);
    await userEvent.click(sortBtn); // descending
    expect(within(bodyRows()[0]!).getByText(name(119))).toBeTruthy();
  });

  it('the stats strip counts every row, not the page', () => {
    renderTab();
    const low = screen.getByRole('button', { name: /low stock/i });
    expect(low.textContent).toContain('40');
    expect(screen.getByRole('button', { name: /out of stock/i }).textContent).toContain('40');
    // Stock value sums every row (40 x 1 + 40 x 50 units at cost 2), not just the 50 shown.
    const allRowsValue = rows.reduce((sum, r) => sum + r.quantityOnHand * 2, 0);
    expect(allRowsValue).toBe(4080);
    expect(screen.getByText(/4,?080(\.00)?/)).toBeTruthy();
  });
});

/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import '@shared/lib/i18n';
import { StockTab } from './StockTab';

vi.mock('@entities/inventory', () => ({
  inventoryRowColumns: () => [],
  useInventory: () => ({ data: [], isLoading: false, resultError: undefined, isEmpty: true }),
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

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <StockTab onOpenCatalog={undefined} />
      <Search />
    </MemoryRouter>
  );
}

async function openAdjust() {
  await userEvent.click(screen.getByRole('button', { name: 'Adjust' }));
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Reason' });
}

describe('StockTab adjustment reason from the address', () => {
  it('the inventory adjustment opens with the reason from the link preselected', async () => {
    renderAt('/inventory?adjustReason=correction');
    expect((await openAdjust()).value).toBe('correction');
  });

  it('?adjustReason=sale is ignored', async () => {
    renderAt('/inventory?adjustReason=sale');
    expect((await openAdjust()).value).toBe('');
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('?adjustReason=offline_sale_reconciliation preselects it and leaves the address', async () => {
    renderAt('/inventory?adjustReason=offline_sale_reconciliation');
    expect((await openAdjust()).value).toBe('offline_sale_reconciliation');
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('the reason parameter is removed from the address after it is read', () => {
    renderAt('/inventory?adjustReason=correction&keep=1');
    expect(screen.getByTestId('search')).toHaveTextContent('?keep=1');
  });
});

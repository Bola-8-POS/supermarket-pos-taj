import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { InventoryAlert } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { useInventoryAlerts } from '../model/queries';
import { LowStockBadge } from './LowStockBadge';

// ---------------------------------------------------------------------------
// Module-level mock — useInventoryAlerts is the only external dependency of
// LowStockBadge. vi.mock is hoisted by Vitest so the mock is active even
// though the import above appears before this call.
// ---------------------------------------------------------------------------
vi.mock('../model/queries', () => ({
  useInventoryAlerts: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AlertHookResult = { data: InventoryAlert[] | undefined; isLoading: boolean };

/** Cast a minimal hook stub to the full hook return type to satisfy TS. */
function stubAlerts(partial: AlertHookResult) {
  vi.mocked(useInventoryAlerts).mockReturnValue(
    partial as unknown as ReturnType<typeof useInventoryAlerts>
  );
}

function makeAlert(
  overrides: Partial<{ productId: string; productName: string }> = {}
): InventoryAlert {
  return {
    productId: overrides.productId ?? 'aaaa0000-0000-0000-0000-000000000001',
    productName: overrides.productName ?? 'Cerveza',
    currentStock: 2,
    threshold: 5,
  };
}

function renderBadge() {
  return renderWithProviders(<LowStockBadge />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LowStockBadge', () => {
  it('renders nothing while data is loading', () => {
    stubAlerts({ data: undefined, isLoading: true });

    renderBadge();

    expect(screen.queryByText(/low stock/i)).toBeNull();
  });

  it('renders nothing when there are no low-stock alerts', () => {
    stubAlerts({ data: [], isLoading: false });

    renderBadge();

    expect(screen.queryByText(/low stock/i)).toBeNull();
  });

  it('renders nothing when alerts is undefined and not loading', () => {
    stubAlerts({ data: undefined, isLoading: false });

    renderBadge();

    expect(screen.queryByText(/low stock/i)).toBeNull();
  });

  it('renders a badge with count of 1 for a single alert', () => {
    stubAlerts({ data: [makeAlert()], isLoading: false });

    renderBadge();

    expect(screen.getByText('1 low stock')).toBeInTheDocument();
  });

  it('renders a badge with the correct count for multiple alerts', () => {
    const alerts = [
      makeAlert({ productId: 'aaaa0000-0000-0000-0000-000000000001', productName: 'Cerveza' }),
      makeAlert({ productId: 'aaaa0000-0000-0000-0000-000000000002', productName: 'Tequila' }),
    ];
    stubAlerts({ data: alerts, isLoading: false });

    renderBadge();

    expect(screen.getByText('2 low stock')).toBeInTheDocument();
  });
});

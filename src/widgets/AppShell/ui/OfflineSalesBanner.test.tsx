/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The dialog has its own tests; here it is a marker that proves the button opens it.
vi.mock('@features/review-offline-sales', () => ({
  OfflineSalesDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" data-testid="offline-sales-dialog" /> : null,
}));

const instance = vi.hoisted(() => ({ role: 'primary' as 'unknown' | 'primary' | 'secondary' }));
vi.mock('@shared/lib/instance-lock', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInstanceRole: () => instance.role,
  getInstanceRole: () => instance.role,
}));

import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { OfflineSalesBanner } from './OfflineSalesBanner';

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const ANA = '77777777-7777-4777-8777-777777777777';

let n = 0;
const sale = (overrides: Partial<OfflineSale> = {}): OfflineSale => {
  n += 1;
  return makeSale({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    receiptNumber: `P-00000${String(n)}`,
    ...overrides,
  });
};
const seed = (...records: OfflineSale[]) => {
  useOfflineSaleStore.setState({ records });
};

beforeEach(() => {
  instance.role = 'primary';
  useStaffStore.setState({ isAuthenticated: true, currentStaff: { id: ME, role: 'cashier' } as Staff });
});
afterEach(() => {
  useOfflineSaleStore.setState({ storageFull: false });
  seed();
  useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
});

describe('OfflineSalesBanner', () => {
  it('a confirmation that cannot be stored is shown on the banner', () => {
    seed(sale({ status: 'queued' }));
    const { rerender } = render(<OfflineSalesBanner />);
    expect(screen.queryByTestId('offline-sales-storage-full')).not.toBeInTheDocument();

    act(() => {
      useOfflineSaleStore.setState({ storageFull: true });
    });
    rerender(<OfflineSalesBanner />);

    expect(screen.getByTestId('offline-sales-storage-full')).toHaveTextContent(/storage is full/i);
    expect(screen.getByTestId('offline-sales-storage-full')).toHaveTextContent(/close the caja|call a manager/i);
    act(() => {
      useOfflineSaleStore.setState({ storageFull: false });
    });
    expect(screen.queryByTestId('offline-sales-storage-full')).not.toBeInTheDocument();
  });

  it('a secondary instance says offline sales are handled in the other window, with or without sales', () => {
    instance.role = 'secondary';
    seed();
    const { unmount } = render(<OfflineSalesBanner />);
    const line = screen.getByTestId('offline-sales-secondary');
    expect(line).toHaveTextContent(/open in another window/i);
    expect(line).toHaveTextContent(/offline sales are handled there/i);
    unmount();

    // alongside the counts when sales are waiting
    seed(sale({ status: 'queued' }));
    render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-secondary')).toBeInTheDocument();
    expect(screen.getByTestId('offline-sales-pending-count')).toBeInTheDocument();
  });

  it('the primary instance shows no such line', () => {
    seed(sale({ status: 'queued' }));
    render(<OfflineSalesBanner />);
    expect(screen.queryByTestId('offline-sales-secondary')).not.toBeInTheDocument();
  });

  it('banner renders nothing when no sale is pending', () => {
    seed(sale({ status: 'confirmed' }), sale({ status: 'resolved' }));
    render(<OfflineSalesBanner />);
    expect(screen.queryByTestId('offline-sales-banner')).not.toBeInTheDocument();
  });

  it('banner shows counts and the waiting-for cashier', () => {
    seed(
      sale({ status: 'queued' }),
      sale({ status: 'replaying' }),
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }),
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }),
      sale({ status: 'queued', staffId: ANA, staffName: 'Ana' })
    );
    render(<OfflineSalesBanner />);

    const banner = screen.getByTestId('offline-sales-banner');
    expect(within(banner).getByTestId('offline-sales-pending-count')).toHaveTextContent(
      '5 offline sales pending'
    );
    expect(within(banner).queryByTestId('offline-sales-review-count')).not.toBeInTheDocument();
    // every distinct waiting cashier is named once, as a list; the signed-in cashier's own sales are not "waiting"
    expect(banner).toHaveTextContent('Waiting for Luis and Ana to sign in');
    expect(banner.textContent?.match(/Luis/g)).toHaveLength(1);
    expect(banner).not.toHaveTextContent('Sofia');
  });

  it('two cashiers with the same name are told apart by id and both listed', () => {
    seed(
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }),
      sale({ status: 'queued', staffId: ANA, staffName: 'Luis' })
    );
    render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-banner')).toHaveTextContent('Luis and Luis');
  });

  it('the waiting-for sentence agrees with one or several cashiers in Spanish', async () => {
    await act(async () => {
      await i18n.changeLanguage('es-MX');
    });
    seed(sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }));
    const { unmount } = render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-banner')).toHaveTextContent(
      'Esperando a que Luis inicie sesión'
    );
    unmount();
    seed(
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }),
      sale({ status: 'queued', staffId: ANA, staffName: 'Ana' })
    );
    render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-banner')).toHaveTextContent(
      'Esperando a que Luis y Ana inicien sesión'
    );
  });

  it('banner uses the singular for one pending sale and shows no waiting-for line for the own cashier', () => {
    seed(sale({ status: 'queued' }));
    render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-pending-count')).toHaveTextContent(
      '1 offline sale pending'
    );
    expect(screen.getByTestId('offline-sales-banner')).not.toHaveTextContent(/Waiting for/);
  });

  it('needs review banner cannot be dismissed', async () => {
    seed(sale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH' }), sale({ status: 'queued' }));
    render(<OfflineSalesBanner />);

    // the destructive count is announced on its own element; the strip itself has no role to flip
    const review = screen.getByRole('alert');
    expect(review).toHaveAttribute('data-testid', 'offline-sales-review-count');
    expect(review).toHaveTextContent('1 needs review');
    const banner = screen.getByTestId('offline-sales-banner');
    expect(banner).not.toHaveAttribute('role');
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'offline-sales-pending-count');
    expect(within(banner).queryByRole('button', { name: /dismiss|close|hide/i })).toBeNull();
    // the only control opens the review dialog
    expect(within(banner).getAllByRole('button')).toHaveLength(1);

    expect(screen.queryByTestId('offline-sales-dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('offline-sales-open-review'));
    expect(screen.getByTestId('offline-sales-dialog')).toBeInTheDocument();
  });

  it('the pending-only banner is a polite status, not an alert', () => {
    seed(sale({ status: 'queued' }));
    render(<OfflineSalesBanner />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'offline-sales-pending-count');
    expect(screen.getByRole('button', { name: /review/i })).toBeInTheDocument();
  });

  it('the banner follows the store when a sale leaves review', () => {
    seed(sale({ status: 'needs_review' }));
    render(<OfflineSalesBanner />);
    expect(screen.getByTestId('offline-sales-banner')).toBeInTheDocument();
    act(() => {
      seed();
    });
    expect(screen.queryByTestId('offline-sales-banner')).not.toBeInTheDocument();
  });
});

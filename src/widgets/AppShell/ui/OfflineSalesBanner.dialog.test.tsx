/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
// The REAL dialog and panel here (the other banner test stubs the dialog): this file is about the
// banner and the dialog sharing one lifetime. Only the server-facing model and the PIN keypad are stubs.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => ({
  retry: vi.fn(),
  writeOff: vi.fn(),
  moveToReview: vi.fn(),
  reRing: vi.fn(),
  printConfirmed: vi.fn(),
}));
vi.mock('@features/review-offline-sales/model/useResolveOfflineSale', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useResolveOfflineSale: () => resolver,
}));
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    onSuccess: (staff: { id: string; role: string }, approvalId: string) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() => {
          props.onSuccess({ id: '88888888-8888-4888-8888-888888888888', role: 'manager' }, 'approval-1');
        }}
      >
        Grant approval
      </button>
    ) : null,
}));
vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { ok } from '@shared/lib/result';
import { OfflineSalesBanner } from './OfflineSalesBanner';

const ME = '22222222-2222-4222-8222-222222222222';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const seed = (...records: OfflineSale[]) => {
  useOfflineSaleStore.setState({ records });
};

beforeEach(() => {
  Object.values(resolver).forEach(fn => fn.mockReset());
  useStaffStore.setState({ isAuthenticated: true, currentStaff: { id: ME, role: 'cashier' } as Staff });
});
afterEach(() => {
  seed();
  useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
});

describe('OfflineSalesBanner with the review dialog', () => {
  it('the dialog stays open when the last pending sale settles', async () => {
    seed(makeSale({ id: A, receiptNumber: 'P-00000A', status: 'needs_review', lastCode: 'AMOUNT_MISMATCH' }));
    // what the real model does: the record leaves review in the store, then the call answers
    resolver.writeOff.mockImplementation((id: string) => {
      const record = makeSale({ id, receiptNumber: 'P-00000A', status: 'resolved', resolution: 'written_off' });
      seed(record);
      return Promise.resolve(ok({ kind: 'written_off', record }));
    });
    render(
      <MemoryRouter>
        <OfflineSalesBanner />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTestId('offline-sales-open-review'));
    expect(screen.getByTestId('offline-sales-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'Customer left, cash counted');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Grant approval' }));

    // nothing is pending or in review any more: the strip is gone, the dialog and its notice are not
    expect(await screen.findByRole('status')).toHaveTextContent(/written off/i);
    expect(screen.getByTestId('offline-sales-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('offline-sales-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-sales-open-review')).not.toBeInTheDocument();

    // closing it renders nothing at all
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('offline-sales-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-sales-banner')).not.toBeInTheDocument();

    // a later queued sale shows the strip with the dialog still CLOSED
    act(() => {
      seed(makeSale({ id: B, receiptNumber: 'P-00000B', status: 'queued' }));
    });
    expect(screen.getByTestId('offline-sales-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('offline-sales-dialog')).not.toBeInTheDocument();
  });
});

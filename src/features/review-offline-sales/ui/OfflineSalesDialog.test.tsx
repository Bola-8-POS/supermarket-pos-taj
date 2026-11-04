/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The resolution model has its own tests; here it is a set of spies the dialog must drive.
const resolver = vi.hoisted(() => ({
  retry: vi.fn(),
  writeOff: vi.fn(),
  moveToReview: vi.fn(),
  reRing: vi.fn(),
  printConfirmed: vi.fn(),
}));
const hookMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../model/useResolveOfflineSale', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useResolveOfflineSale: () => {
    hookMounts.count += 1;
    return resolver;
  },
}));

// A stand-in for the PIN keypad: it records how it was opened and lets a test grant or cancel.
const grants = vi.hoisted(() => ({ next: 0 }));
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    requiredAction: string;
    onOpenChange: (open: boolean) => void;
    onSuccess: (staff: { id: string; role: string }, approvalId: string) => void;
    offlineCapable?: boolean;
    description?: string;
  }) =>
    props.open ? (
      <div
        role="dialog"
        aria-label="PIN gate"
        data-required-action={props.requiredAction}
        data-offline-capable={String(props.offlineCapable ?? false)}
      >
        <p data-testid="pin-gate-description">{props.description}</p>
        <button
          type="button"
          onClick={() => {
            grants.next += 1;
            props.onSuccess({ id: MANAGER, role: 'manager' }, `approval-${String(grants.next)}`);
          }}
        >
          Grant approval
        </button>
        <button
          type="button"
          onClick={() => {
            props.onOpenChange(false);
          }}
        >
          Cancel PIN
        </button>
      </div>
    ) : null,
}));

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

const can = vi.hoisted(() => ({ adjust: true }));
vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: (a: string) => a === 'adjust_inventory' && can.adjust, ready: true }),
}));

import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { OfflineSaleLastCodeSchema } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { err, ok } from '@shared/lib/result';
import { OFFLINE_SALE_APPROVAL_ACTION } from '../model/useResolveOfflineSale';
import { OfflineSalesDialog } from './OfflineSalesDialog';

const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const MANAGER = '88888888-8888-4888-8888-888888888888';
const TAB = '9f8e7d6c-1111-4222-8333-444444444444';

let n = 0;
const sale = (overrides: Partial<OfflineSale> = {}): OfflineSale => {
  n += 1;
  return makeSale({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    receiptNumber: `P-00000${String(n)}`,
    soldAt: `2026-10-09T10:0${String(n % 10)}:00.000Z`,
    ...overrides,
  });
};
const review = (overrides: Partial<OfflineSale> = {}) =>
  sale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1, ...overrides });
const seed = (...records: OfflineSale[]) => {
  useOfflineSaleStore.setState({ records });
};
const recordOf = (receipt: string): OfflineSale => {
  const found = useOfflineSaleStore.getState().records.find(r => r.receiptNumber === receipt);
  if (!found) throw new Error(`no record ${receipt}`);
  return found;
};
/** What the real model does before it answers: the stored record becomes the one it returns. */
const settle = (record: OfflineSale): OfflineSale => {
  useOfflineSaleStore.setState(state => ({
    records: state.records.map(r => (r.id === record.id ? record : r)),
  }));
  return record;
};
const change = (receipt: string, patch: Partial<OfflineSale>): OfflineSale =>
  settle({ ...recordOf(receipt), ...patch });

function renderDialog(onOpenChange = vi.fn(), open = true) {
  render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/pos" element={<div>POS page</div>} />
        <Route path="*" element={<OfflineSalesDialog open={open} onOpenChange={onOpenChange} />} />
      </Routes>
    </MemoryRouter>
  );
  return { onOpenChange };
}
const rows = () => screen.getAllByTestId('offline-sale-row');
const rowFor = (receipt: string) => {
  const row = rows().find(r => r.getAttribute('data-receipt-number') === receipt);
  if (!row) throw new Error(`no row for ${receipt}`);
  return row;
};
const grant = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Grant approval' }));
};

beforeEach(() => {
  n = 0;
  grants.next = 0;
  hookMounts.count = 0;
  can.adjust = true;
  Object.values(resolver).forEach(fn => fn.mockReset());
  Object.values(log).forEach(fn => fn.mockReset());
  useStaffStore.setState({ isAuthenticated: true, currentStaff: { id: ME, role: 'cashier' } as Staff });
});
afterEach(() => {
  seed();
  useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
});

describe('OfflineSalesDialog', () => {
  it('does not mount the resolution model or render anything while closed', () => {
    seed(review());
    const { onOpenChange } = renderDialog(vi.fn(), false);
    expect(screen.queryByTestId('offline-sales-dialog')).not.toBeInTheDocument();
    expect(hookMounts.count).toBe(0);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('lists needs-review, pending, confirmed, resolved in that order, newest first inside a group', () => {
    seed(
      sale({ status: 'resolved', resolution: 'written_off' }),
      sale({ status: 'confirmed', tabId: TAB }),
      sale({ status: 'queued' }),
      review({ soldAt: '2026-10-09T09:00:00.000Z' }),
      review({ soldAt: '2026-10-09T11:30:00.000Z' })
    );
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Offline sales' })).toBeInTheDocument();
    expect(screen.getByTestId('offline-sales-dialog')).toBeInTheDocument();
    expect(rows().map(r => r.getAttribute('data-status'))).toEqual([
      'needs_review',
      'needs_review',
      'queued',
      'confirmed',
      'resolved',
    ]);
    // newest first within the needs-review group (sale 5 was rung at 11:30, sale 4 at 09:00)
    expect(rows().map(r => r.getAttribute('data-receipt-number')).slice(0, 2)).toEqual([
      'P-000005',
      'P-000004',
    ]);
    expect(screen.getByRole('heading', { name: /Needs review/ })).toBeInTheDocument();
  });

  it('shows P- number, total, method, cashier and state on a row', () => {
    seed(
      review({
        staffName: 'Sofia',
        request: {
          ...makeSale().request,
          method: undefined,
          amount: undefined,
          legs: [
            { method: 'cash', amount: 5 },
            { method: 'card', amount: 7.5, referenceNumber: 'AUTH1' },
          ],
          expectedTotal: 12.5,
        },
      })
    );
    renderDialog();
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveTextContent('P-000001');
    expect(row).toHaveTextContent('$12.50');
    expect(row).toHaveTextContent('Split');
    expect(row).toHaveTextContent('Sofia');
    expect(within(row).getByTestId('offline-sale-state')).toHaveTextContent('Needs review');
  });

  it('dialog shows the confirmed receipt number beside the provisional number', async () => {
    seed(sale({ status: 'confirmed', tabId: TAB }));
    resolver.printConfirmed.mockResolvedValue(ok({ jobId: 'job' }));
    renderDialog();
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveTextContent('P-000001');
    expect(row).toHaveTextContent('9F8E7D6C');
    await userEvent.click(within(row).getByTestId('offline-sale-print-confirmed'));
    expect(resolver.printConfirmed).toHaveBeenCalledWith(expect.stringMatching(/^00000000-/));
    expect(await within(row).findByRole('status')).toHaveTextContent(/printer/i);
  });

  it('print confirmed is unavailable with a reason for a slimmed sale', () => {
    seed(sale({ status: 'confirmed', tabId: TAB, slimmed: true, lines: [] }));
    renderDialog();
    const row = rows()[0] as HTMLElement;
    expect(within(row).queryByTestId('offline-sale-print-confirmed')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-print-unavailable')).toHaveTextContent(
      /reprint it from Payments/i
    );
  });

  it('a double tap on print confirmed in the review panel prints once', async () => {
    seed(sale({ status: 'confirmed', tabId: TAB }));
    resolver.printConfirmed.mockResolvedValue(ok({ jobId: 'job' }));
    renderDialog();
    const button = within(rows()[0] as HTMLElement).getByTestId('offline-sale-print-confirmed');
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(within(rows()[0] as HTMLElement).getByTestId('offline-sale-print-confirmed')).toBeEnabled();
    });
    expect(resolver.printConfirmed).toHaveBeenCalledTimes(1);
    // a deliberate second tap after the first settles still prints
    await userEvent.click(within(rows()[0] as HTMLElement).getByTestId('offline-sale-print-confirmed'));
    expect(resolver.printConfirmed).toHaveBeenCalledTimes(2);
  });

  it('a resolved sale shows how it was resolved and the linked sale number, with no actions', () => {
    seed(
      sale({ status: 'resolved', resolution: 'rering', linkedTabId: TAB, customerOverpaid: 1.5 }),
      sale({ status: 'resolved', resolution: 'written_off' }),
      sale({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB })
    );
    renderDialog();
    const [a, b, c] = [rowFor('P-000001'), rowFor('P-000002'), rowFor('P-000003')];
    expect(a).toHaveTextContent(/re-rung/i);
    expect(a).toHaveTextContent('9F8E7D6C');
    expect(a).toHaveTextContent('$1.50');
    expect(b).toHaveTextContent(/written off/i);
    expect(c).toHaveTextContent(/already recorded/i);
    for (const row of [a, b, c]) expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });

  it('a resolved sale with a shortfall says the server holds less, never overpaid', () => {
    seed(sale({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB, amountShort: 2.5 }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(row).toHaveTextContent(/server holds \$2\.50 less than the offline sale/i);
    expect(row).not.toHaveTextContent(/more than/i);
  });

  it('a record closed with the original over a duplicate re-ring tells the manager to refund the re-ring', () => {
    seed(sale({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB, duplicateReringTabId: '9f8e7d6c-1111-4222-8333-444455556666' }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).getByTestId('offline-sale-duplicate-rering')).toHaveTextContent(/reached the server twice.*Refund the re-ring sale \(9F8E7D6C\) on Payments/i);
  });

  it('a refused sale shows a plain-language reason for every refusal code', async () => {
    for (const lng of ['en-US', 'es-MX'] as const) {
      const t = i18n.getFixedT(lng);
      for (const code of OfflineSaleLastCodeSchema.options) {
        const key = `featOrders:reviewOfflineSales.dialog.reason.${code}`;
        // a code with no catalog entry in a locale fails here, not silently in the shop
        expect(i18n.exists(key, { lng }), `${lng} ${code}`).toBe(true);
        const text = t(key);
        expect(text.length, `${lng} ${code}`).toBeGreaterThan(10);
        expect(text, `${lng} ${code}`).not.toBe(key);
        expect(text, `${lng} ${code} must not be the raw code`).not.toBe(code);
      }
    }

    for (const lng of ['en-US', 'es-MX'] as const) {
      await act(async () => {
        await i18n.changeLanguage(lng);
      });
      for (const code of OfflineSaleLastCodeSchema.options) {
        n = 0;
        seed(review({ lastCode: code, lastMessage: 'RAW SERVER TEXT 4711' }));
        const { unmount } = render(
          <MemoryRouter>
            <OfflineSalesDialog open onOpenChange={vi.fn()} />
          </MemoryRouter>
        );
        const reason = screen.getByTestId('offline-sale-reason');
        expect(reason, `${lng} ${code}`).toHaveTextContent(
          i18n.getFixedT(lng)(`featOrders:reviewOfflineSales.dialog.reason.${code}`)
        );
        // the raw server text is small secondary detail only, never the reason itself
        expect(reason).not.toHaveTextContent('RAW SERVER TEXT');
        expect(screen.getByTestId('offline-sale-server-detail')).toHaveTextContent('RAW SERVER TEXT 4711');
        unmount();
      }
    }
  });

  it('a refused sale with no stored code still explains itself', () => {
    seed(review({ lastCode: undefined }));
    renderDialog();
    expect(screen.getByTestId('offline-sale-reason')).toHaveTextContent(
      i18n.t('featOrders:reviewOfflineSales.dialog.reason.UNKNOWN')
    );
  });

  it('manager actions ask for a manager approval and do nothing without one', async () => {
    seed(review(), sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }));
    renderDialog();
    // the signed-in user is a cashier: the buttons are there, each one leads to the PIN gate
    const needsReview = rowFor('P-000001');
    const waiting = rowFor('P-000002');

    await userEvent.click(within(needsReview).getByTestId('offline-sale-rering'));
    expect(screen.getByRole('dialog', { name: 'PIN gate' })).toHaveAttribute(
      'data-required-action',
      OFFLINE_SALE_APPROVAL_ACTION
    );
    // never the gate's offline mode: every one of these actions needs the server
    expect(screen.getByRole('dialog', { name: 'PIN gate' })).toHaveAttribute('data-offline-capable', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

    await userEvent.click(within(needsReview).getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'Customer left, cash counted');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    expect(screen.getByRole('dialog', { name: 'PIN gate' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

    await userEvent.click(within(waiting).getByTestId('offline-sale-move-to-review'));
    expect(screen.getByRole('dialog', { name: 'PIN gate' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

    expect(resolver.reRing).not.toHaveBeenCalled();
    expect(resolver.writeOff).not.toHaveBeenCalled();
    expect(resolver.moveToReview).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'PIN gate' })).not.toBeInTheDocument();
  });

  it('the PIN prompt names the action, the receipt number, the total and the cashier', async () => {
    seed(
      review({ staffName: 'Sofia' }),
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' })
    );
    renderDialog();
    const needsReview = rowFor('P-000001');
    const waiting = rowFor('P-000002');
    const prompt = () => screen.getByTestId('pin-gate-description');

    // re-ring
    await userEvent.click(within(needsReview).getByTestId('offline-sale-rering'));
    expect(prompt()).toHaveTextContent(/re-ring this sale/i);
    expect(prompt()).toHaveTextContent('P-000001');
    expect(prompt()).toHaveTextContent('$9.00');
    expect(prompt()).toHaveTextContent('Sofia');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

    // write off: says plainly that the server will not hear of it
    await userEvent.click(within(needsReview).getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'Customer left, cash counted');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    expect(prompt()).toHaveTextContent(/write off this sale/i);
    expect(prompt()).toHaveTextContent(/NOT be recorded on the server/);
    expect(prompt()).toHaveTextContent('P-000001');
    expect(prompt()).toHaveTextContent('$9.00');
    expect(prompt()).toHaveTextContent('Sofia');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

    // move to review
    await userEvent.click(within(waiting).getByTestId('offline-sale-move-to-review'));
    expect(prompt()).toHaveTextContent(/move this sale to review/i);
    expect(prompt()).toHaveTextContent('P-000002');
    expect(prompt()).toHaveTextContent('$9.00');
    expect(prompt()).toHaveTextContent('Luis');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));
  });

  it('a re-ring that was already paid is linked and never hands the cart to the checkout', async () => {
    seed(review());
    resolver.reRing.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'already_rerung', record: change('P-000001', {}), tabId: TAB }))
    );
    renderDialog();
    await userEvent.click(within(rowFor('P-000001')).getByTestId('offline-sale-rering'));
    await grant();
    expect(await screen.findByText(/already re-rung and paid/i)).toBeInTheDocument();
    expect(screen.queryByText('POS page')).not.toBeInTheDocument();
  });

  it('a write-off over a paid re-ring answers already_rerung and shows the same linked copy', async () => {
    seed(review());
    resolver.writeOff.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'already_rerung', record: change('P-000001', {}), tabId: TAB }))
    );
    renderDialog();
    await userEvent.click(within(rowFor('P-000001')).getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'customer left without paying');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    await grant();
    expect(await screen.findByText(/already re-rung and paid/i)).toBeInTheDocument();
  });

  it('the write-off reason field stops at 500 characters', async () => {
    seed(review());
    renderDialog();
    await userEvent.click(within(rowFor('P-000001')).getByTestId('offline-sale-writeoff'));
    expect(screen.getByRole('textbox', { name: /reason/i })).toHaveAttribute('maxlength', '500');
  });

  it('each manager action opens the PIN gate once and does not reuse an approval', async () => {
    seed(review(), review(), sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }));
    resolver.reRing.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'already_recorded', record: change('P-000001', {}), tabId: TAB }))
    );
    resolver.writeOff.mockImplementation(() =>
      Promise.resolve(
        ok({
          kind: 'written_off',
          record: change('P-000002', { status: 'resolved', resolution: 'written_off' }),
        })
      )
    );
    resolver.moveToReview.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'moved_to_review', record: change('P-000003', { status: 'needs_review' }) }))
    );
    renderDialog();
    const gate = () => screen.queryByRole('dialog', { name: 'PIN gate' });

    // 1. re-ring
    await userEvent.click(within(rowFor('P-000001')).getByTestId('offline-sale-rering'));
    expect(resolver.reRing).not.toHaveBeenCalled();
    await grant();
    expect(resolver.reRing).toHaveBeenCalledTimes(1);
    expect(resolver.reRing.mock.calls[0]?.[1]).toEqual({
      approvalId: 'approval-1',
      action: OFFLINE_SALE_APPROVAL_ACTION,
      approver: { id: MANAGER },
    });
    expect(gate()).not.toBeInTheDocument();

    // 2. write off: a second action asks for a second PIN, nothing runs until it is granted
    await userEvent.click(within(rowFor('P-000002')).getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'Customer left, cash counted');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    expect(resolver.writeOff).not.toHaveBeenCalled();
    expect(resolver.reRing).toHaveBeenCalledTimes(1);
    await grant();
    expect(resolver.writeOff).toHaveBeenCalledTimes(1);
    expect(resolver.writeOff.mock.calls[0]?.[2]).toMatchObject({ approvalId: 'approval-2' });
    expect(gate()).not.toBeInTheDocument();

    // 3. move to review
    await userEvent.click(within(rowFor('P-000003')).getByTestId('offline-sale-move-to-review'));
    expect(resolver.moveToReview).not.toHaveBeenCalled();
    await grant();
    expect(resolver.moveToReview).toHaveBeenCalledTimes(1);
    expect(resolver.moveToReview.mock.calls[0]?.[1]).toMatchObject({ approvalId: 'approval-3' });
    expect(gate()).not.toBeInTheDocument();

    // each action got exactly its own approval and none ran twice
    expect(resolver.reRing).toHaveBeenCalledTimes(1);
    expect(resolver.writeOff).toHaveBeenCalledTimes(1);
    expect(resolver.moveToReview).toHaveBeenCalledTimes(1);
  });

  it('write off requires a reason of at least 10 characters', async () => {
    seed(review());
    resolver.writeOff.mockImplementation(() =>
      Promise.resolve(
        ok({
          kind: 'written_off',
          record: change('P-000001', { status: 'resolved', resolution: 'written_off' }),
        })
      )
    );
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-writeoff'));

    const reason = screen.getByRole('textbox', { name: /reason/i });
    // the cashier can type at once
    expect(reason).toHaveFocus();
    const confirm = screen.getByRole('button', { name: /confirm write off/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(reason, '  short  ');
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      i18n.t('featOrders:reviewOfflineSales.reasonTooShort')
    );

    await userEvent.clear(reason);
    // 10 characters once trimmed
    await userEvent.type(reason, '  0123456789  ');
    expect(confirm).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.click(confirm);
    await grant();
    expect(resolver.writeOff).toHaveBeenCalledWith(
      expect.stringMatching(/^00000000-/),
      '  0123456789  ',
      expect.objectContaining({ approvalId: 'approval-1' })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/written off/i);
  });

  it('an already recorded outcome is shown as good news', async () => {
    seed(review());
    resolver.writeOff.mockImplementation(() =>
      Promise.resolve(
        ok({
          kind: 'already_recorded',
          record: change('P-000001', {
            status: 'resolved',
            resolution: 'already_recorded',
            linkedTabId: TAB,
          }),
          tabId: TAB,
        })
      )
    );
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-writeoff'));
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'Customer left, cash counted');
    await userEvent.click(screen.getByRole('button', { name: /confirm write off/i }));
    await grant();

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/good news/i);
    expect(notice).toHaveTextContent(/already/i);
    expect(notice).toHaveTextContent('9F8E7D6C');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("another cashier's queued sale offers move to review, the signed-in cashier's does not", async () => {
    seed(
      sale({ status: 'queued' }),
      sale({ status: 'replaying' }),
      sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' })
    );
    renderDialog();
    const own = rowFor('P-000001');
    expect(within(own).queryAllByRole('button')).toHaveLength(0);
    expect(own).toHaveTextContent(/sent automatically|waiting to send/i);
    expect(within(rowFor('P-000002')).queryAllByRole('button')).toHaveLength(0);

    const theirs = rowFor('P-000003');
    expect(theirs).toHaveTextContent(/Waiting for Luis/);
    resolver.moveToReview.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'moved_to_review', record: change('P-000003', { status: 'needs_review' }) }))
    );
    await userEvent.click(within(theirs).getByTestId('offline-sale-move-to-review'));
    await grant();
    expect(resolver.moveToReview).toHaveBeenCalledWith(
      expect.stringMatching(/^00000000-/),
      expect.objectContaining({ approvalId: 'approval-1' })
    );
  });

  it("the signed-in cashier's held sale offers move to review and says why", async () => {
    seed(
      sale({ status: 'queued', attempts: 3, nextAttemptAt: '2026-10-09T10:30:00.000Z' }),
      sale({ status: 'queued' })
    );
    renderDialog();
    const held = rowFor('P-000001');
    expect(held).toHaveTextContent(/could not be confirmed/i);
    resolver.moveToReview.mockImplementation(() =>
      Promise.resolve(ok({ kind: 'moved_to_review', record: change('P-000001', { status: 'needs_review' }) }))
    );
    await userEvent.click(within(held).getByTestId('offline-sale-move-to-review'));
    await grant();
    expect(resolver.moveToReview).toHaveBeenCalledTimes(1);

    // a sale that is not held stays hands-off
    expect(within(rowFor('P-000002')).queryAllByRole('button')).toHaveLength(0);
  });

  it('nobody signed in offers move to review on no queued sale', () => {
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
    seed(sale({ status: 'queued', staffId: OTHER, staffName: 'Luis' }), sale({ status: 'queued' }));
    renderDialog();
    expect(screen.queryByTestId('offline-sale-move-to-review')).not.toBeInTheDocument();
  });

  it('retry needs no approval', async () => {
    seed(review());
    resolver.retry.mockImplementation(() => ok(change('P-000001', { status: 'queued' })));
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-retry'));
    expect(screen.queryByRole('dialog', { name: 'PIN gate' })).not.toBeInTheDocument();
    expect(resolver.retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(/queued to send again/i);
  });

  it("a model refusal is shown with the model's own message", async () => {
    seed(review());
    const message = i18n.t('featOrders:reviewOfflineSales.reRingCartNotEmpty');
    resolver.reRing.mockResolvedValue(err({ code: 'VALIDATION_ERROR', message }));
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-rering'));
    await grant();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(message).toMatch(/cart is not empty/i);
  });

  it('retry shows the model refusal too', async () => {
    seed(review());
    resolver.retry.mockReturnValue(
      err({ code: 'VALIDATION_ERROR', message: i18n.t('featOrders:reviewOfflineSales.busy') })
    );
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-retry'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/another action on this sale/i);
  });

  it('an action that throws shows the generic message, is logged, and frees the row', async () => {
    seed(review());
    resolver.reRing.mockRejectedValue(new Error('boom'));
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-rering'));
    await grant();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      i18n.t('featOrders:reviewOfflineSales.dialog.failed')
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('boom');
    expect(log.error).toHaveBeenCalled();
    expect(screen.getByTestId('offline-sale-rering')).toBeEnabled();
  });

  it('a notice goes away when its row starts another action or changes status', async () => {
    seed(review());
    resolver.reRing.mockResolvedValue(err({ code: 'VALIDATION_ERROR', message: 'First refusal' }));
    resolver.retry.mockImplementation(() => ok(change('P-000001', { status: 'queued' })));
    renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-rering'));
    await grant();
    expect(await screen.findByRole('alert')).toHaveTextContent('First refusal');
    // starting a new action on the row clears the old notice
    await userEvent.click(screen.getByTestId('offline-sale-retry'));
    expect(screen.queryByText('First refusal')).not.toBeInTheDocument();
    // the success notice belongs to the queued state; when the row moves on, it goes
    expect(screen.getByRole('status')).toHaveTextContent(/queued to send again/i);
    act(() => {
      change('P-000001', { status: 'replaying' });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables a row while its action is pending, and only that row', async () => {
    seed(review(), review());
    const finish: ((v: unknown) => void)[] = [];
    resolver.reRing.mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    renderDialog();
    const a = rowFor('P-000001');
    const b = rowFor('P-000002');
    await userEvent.click(within(a).getByTestId('offline-sale-rering'));
    await grant();
    expect(within(a).getByTestId('offline-sale-rering')).toBeDisabled();
    expect(within(a).getByTestId('offline-sale-retry')).toBeDisabled();
    expect(within(a).getByTestId('offline-sale-writeoff')).toBeDisabled();
    expect(within(b).getByTestId('offline-sale-rering')).toBeEnabled();

    // starting row B and finishing it first does not re-enable row A
    await userEvent.click(within(b).getByTestId('offline-sale-rering'));
    await grant();
    expect(within(b).getByTestId('offline-sale-rering')).toBeDisabled();
    await act(async () => {
      finish[1]?.(err({ code: 'VALIDATION_ERROR', message: 'x' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(b).getByTestId('offline-sale-rering')).toBeEnabled();
    });
    expect(within(a).getByTestId('offline-sale-rering')).toBeDisabled();

    await act(async () => {
      finish[0]?.(err({ code: 'VALIDATION_ERROR', message: 'x' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(a).getByTestId('offline-sale-rering')).toBeEnabled();
    });
  });

  it('a successful re-ring closes the dialog and opens the checkout', async () => {
    seed(review());
    resolver.reRing.mockResolvedValue(ok({ kind: 'rering', cartItems: [], paidTotal: 9 }));
    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByTestId('offline-sale-rering'));
    await grant();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(await screen.findByText('POS page')).toBeInTheDocument();
  });

  it('the adjust stock link carries the offline_sale_reconciliation reason', () => {
    seed(review({ lastCode: 'INVENTORY_NEGATIVE' }));
    renderDialog();
    const link = within(rowFor('P-000001')).getByTestId('offline-sale-adjust-stock');
    expect(link).toHaveAttribute('href', '/inventory?adjustReason=offline_sale_reconciliation');
  });

  it('adjust stock is offered only for an inventory refusal and only to someone who can adjust stock', () => {
    seed(review({ lastCode: 'INVENTORY_NEGATIVE' }), review());
    renderDialog();
    const link = within(rowFor('P-000001')).getByTestId('offline-sale-adjust-stock');
    expect(link).toHaveAttribute('href', '/inventory?adjustReason=offline_sale_reconciliation');
    expect(within(rowFor('P-000002')).queryByTestId('offline-sale-adjust-stock')).not.toBeInTheDocument();
    // Retry stays a separate click
    expect(within(rowFor('P-000001')).getByTestId('offline-sale-retry')).toBeInTheDocument();
  });

  it('a cashier is told how an out-of-stock sale gets resolved', () => {
    can.adjust = false;
    seed(review({ lastCode: 'INVENTORY_NEGATIVE' }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-adjust-stock')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-ask-manager-stock')).toHaveTextContent(
      'Ask a manager to correct the stock for this item from Inventory on another device, then tap Retry here. If that is not possible, a manager can write the sale off with their PIN.'
    );
    // Retry stays
    expect(within(row).getByTestId('offline-sale-retry')).toBeInTheDocument();
  });

  it('does not tell a role that can adjust stock to ask a manager', () => {
    seed(review({ lastCode: 'INVENTORY_NEGATIVE' }));
    renderDialog();
    expect(screen.queryByTestId('offline-sale-ask-manager-stock')).not.toBeInTheDocument();
  });

  it('a tampered sale offers only write off', () => {
    seed(review({ lastCode: 'TAMPERED' }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-retry')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('offline-sale-rering')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-writeoff')).toBeInTheDocument();
  });

  it('the panel does not offer retry for a sale with a re-ring attempt', () => {
    seed(review({ reRingAttemptKeys: ['direct_sale_rr_1'] }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-retry')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-rering')).toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-writeoff')).toBeInTheDocument();
  });

  it('the panel does not offer retry after a lost write-off answer', () => {
    seed(review({ resolutionOutcomeUnknown: true }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-retry')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-writeoff')).toBeInTheDocument();
  });

  it('the panel does not offer re-ring after a lost write-off answer', () => {
    seed(review({ resolutionOutcomeUnknown: true }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-rering')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-writeoff')).toBeInTheDocument();
  });

  it("the panel does not offer retry for another cashier's sale", () => {
    seed(review({ staffId: OTHER, staffName: 'Luis' }));
    renderDialog();
    const row = rowFor('P-000001');
    expect(within(row).queryByTestId('offline-sale-retry')).not.toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-rering')).toBeInTheDocument();
    expect(within(row).getByTestId('offline-sale-writeoff')).toBeInTheDocument();
  });

  it('row actions carry the receipt number in their accessible name', () => {
    seed(review({ lastCode: 'INVENTORY_NEGATIVE' }), sale({ status: 'confirmed', tabId: TAB }));
    renderDialog();
    expect(screen.getByRole('button', { name: /^Retry.*P-000001/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Re-ring.*P-000001/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Write off.*P-000001/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Adjust stock.*P-000001/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Print confirmed receipt.*P-000002/ })
    ).toBeInTheDocument();
  });

  it('shows an empty state once every sale is settled away', () => {
    seed();
    renderDialog();
    expect(screen.getByText(/no offline sales/i)).toBeInTheDocument();
  });
});

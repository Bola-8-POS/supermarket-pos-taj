/* eslint-disable i18next/no-literal-string -- story fixtures and titles, not UI copy. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { err, ok } from '@shared/lib/result';
import type { OfflineSaleResolver } from '../model/useResolveOfflineSale';
import { OfflineSalesPanel } from './OfflineSalesPanel';

const SHOP = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

function sale(n: number, overrides: Partial<OfflineSale>): OfflineSale {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    request: {
      items: [{ productId: PRODUCT, quantity: 2, unitPrice: 4.5, modifierIds: [], modifierPriceDelta: 0 }],
      shiftId: '44444444-4444-4444-8444-444444444444',
      cajaSessionId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: `direct_sale_${String(n)}`,
      method: 'cash',
      amount: 9,
      tenderedAmount: 10,
      expectedTotal: 9,
      terminalId: 'POS-1',
    },
    lines: [{ productId: PRODUCT, name: 'Basmati rice 1kg', categoryName: 'Rice', modifierNames: [] }],
    soldAt: `2026-10-09T10:${String(10 + n)}:00.000Z`,
    staffId: SHOP,
    staffName: 'Sofia',
    receiptNumber: `P-A1B2C${String(n)}`,
    status: 'queued',
    attempts: 0,
    integrity: 'abc',
    reRingAttemptKeys: [],
    resolutionOutcomeUnknown: false,
    ...overrides,
  };
}

// A stand-in: the stories show the rows, not the server.
const resolver: OfflineSaleResolver = {
  retry: () => err({ code: 'NOT_FOUND', message: 'story' }),
  writeOff: () => Promise.resolve(err({ code: 'NETWORK_OFFLINE', message: 'story' })),
  moveToReview: () => Promise.resolve(err({ code: 'NETWORK_OFFLINE', message: 'story' })),
  reRing: () => Promise.resolve(err({ code: 'NETWORK_OFFLINE', message: 'story' })),
  printConfirmed: () => Promise.resolve(ok({ jobId: 'story' })),
};

const needsReview = sale(1, {
  status: 'needs_review',
  lastCode: 'AMOUNT_MISMATCH',
  lastMessage: 'amount 9.00 does not match derived total 9.50',
  attempts: 1,
});
const noStock = sale(2, { status: 'needs_review', lastCode: 'INVENTORY_NEGATIVE', attempts: 1 });
const sending = sale(3, { status: 'replaying' });
const waitingForOther = sale(4, { status: 'queued', staffId: OTHER, staffName: 'Luis' });
const confirmed = sale(5, { status: 'confirmed', tabId: '9f8e7d6c-1111-4222-8333-444444444444' });
const reRung = sale(6, {
  status: 'resolved',
  resolution: 'rering',
  linkedTabId: '1a2b3c4d-1111-4222-8333-444444444444',
  customerOverpaid: 1.5,
});
const writtenOff = sale(7, { status: 'resolved', resolution: 'written_off' });
const alreadyRecorded = sale(8, {
  status: 'resolved',
  resolution: 'already_recorded',
  linkedTabId: '5e6f7a8b-1111-4222-8333-444444444444',
});

const meta = {
  title: 'Features/ReviewOfflineSales/OfflineSalesDialog',
  component: OfflineSalesPanel,
  tags: ['autodocs'],
  decorators: [
    Story => (
      <MemoryRouter>
        <div className="max-w-3xl rounded-2xl border border-border bg-popover p-6">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: {
    records: [],
    signedInStaffId: SHOP,
    resolver,
    canAdjustStock: true,
    onClose: () => undefined,
  },
} satisfies Meta<typeof OfflineSalesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsReview: Story = { args: { records: [needsReview, noStock] } };
export const PendingAndWaiting: Story = { args: { records: [sending, waitingForOther] } };
export const Confirmed: Story = { args: { records: [confirmed] } };
export const Resolved: Story = { args: { records: [reRung, writtenOff, alreadyRecorded] } };
export const Everything: Story = {
  args: {
    records: [needsReview, noStock, sending, waitingForOther, confirmed, reRung, writtenOff, alreadyRecorded],
  },
};
export const Empty: Story = { args: { records: [] } };

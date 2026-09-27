import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import type { Tab } from '@entities/tab/model/types';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { logger } from '@shared/lib/logger';
import { scenarios } from '@shared/lib/mocks';
import { ok } from '@shared/lib/result';
import { PaymentModal, type PaymentProcessors } from './index';

const staffId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

const closingTabs = scenarios.closingTime.tabs;
const baseTab: Tab = closingTabs[0] ?? scenarios.busyBar.tabs[0]!;

function stubReceipt(tab: Tab): ReceiptData {
  return {
    receiptNumber: 'STUB1234',
    tabId: tab.id,
    customerName: tab.customerName,
    cashierName: 'Story',
    storeName: 'Story Bar',
    barAddress: '',
    items: [],
    subtotal: 0,
    total: 0,
    paymentMethod: 'cash',
    processedAt: new Date(),
    squareReceiptUrl: null,
  };
}

function mockProcessorsFor(tab: Tab): PaymentProcessors {
  const receipt = stubReceipt(tab);
  return {
    processCashPayment: async (_tabId, amount, tendered) => {
      logger.info('storybook.payment.mock', { method: 'cash', amount, tendered });
      await new Promise(r => setTimeout(r, 400));
      return ok({
        paymentId: '00000000-0000-4000-8000-000000000001',
        changeAmount: Math.max(0, tendered - amount),
        receiptData: {
          ...receipt,
          subtotal: amount,
          total: amount,
          tenderedAmount: tendered,
          changeAmount: Math.max(0, tendered - amount),
        },
      });
    },
    processCardPayment: async (_tabId, amount) => {
      logger.info('storybook.payment.mock', { method: 'card', amount });
      await new Promise(r => setTimeout(r, 400));
      return ok({
        paymentId: '00000000-0000-4000-8000-000000000002',
        receiptData: {
          ...receipt,
          paymentMethod: 'card',
          subtotal: amount,
          total: amount,
        },
      });
    },
    processPlatformPayment: async (_tabId, amount, method) => {
      logger.info('storybook.payment.mock', { method, amount });
      await new Promise(r => setTimeout(r, 400));
      return ok({
        paymentId: '00000000-0000-4000-8000-000000000003',
        receiptData: {
          ...receipt,
          paymentMethod: method,
          subtotal: amount,
          total: amount,
        },
      });
    },
    processSplitPayment: async (_tabId, legs) => {
      logger.info('storybook.payment.mock', { method: 'split', legCount: legs.length });
      await new Promise(r => setTimeout(r, 400));
      return ok({
        paymentGroupId: '00000000-0000-4000-8000-000000000004',
        paymentIds: legs.map((_, i) => `00000000-0000-4000-8000-00000000001${String(i)}`),
        receipts: legs.map(leg => ({
          ...receipt,
          paymentMethod: leg.method,
          subtotal: leg.amount,
          total: leg.amount,
        })),
      });
    },
  };
}

const meta = {
  title: 'Widgets/PaymentModal',
  component: PaymentModal,
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CashPayment: Story = {
  args: {
    open: true,
    tab: baseTab,
    staffId,
    onClose: () => {},
    processors: mockProcessorsFor(baseTab),
  },
};

export const CardPayment: Story = {
  args: {
    open: true,
    tab: baseTab,
    staffId,
    onClose: () => {},
    processors: mockProcessorsFor(baseTab),
  },
  play: async () => {
    const root = within(document.body);
    const cardButton = await root.findByRole('button', { name: 'Terminal' });
    await userEvent.setup().click(cardButton);
  },
};

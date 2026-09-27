import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { ReceiptPreview } from './ReceiptPreview';

const baseItems: ReceiptData['items'] = [
  { name: 'Cerveza', quantity: 2, unitPrice: 45, lineTotal: 90 },
  { name: 'Nachos', quantity: 1, unitPrice: 120, lineTotal: 120 },
];

const base: ReceiptData = {
  receiptNumber: 'A1B2C3D4',
  tabId: '123e4567-e89b-12d3-a456-426614174000',
  customerName: 'María G.',
  cashierName: 'Luis P.',
  storeName: 'Bola 8 Cantina',
  barAddress: 'Av. Insurgentes 123, CDMX',
  items: baseItems,
  // Inclusive-mode sale (D-01 default): the $210 catalog-price sum IS the
  // charged total; subtotal is decomposed backward at 16% (Pitfall 4/5/6 —
  // not a degenerate subtotal===total fixture).
  subtotal: 181.03,
  taxAmount: 28.97,
  taxRatePercent: 16,
  taxInclusive: true,
  total: 210,
  paymentMethod: 'cash',
  processedAt: new Date('2026-04-17T14:30:00'),
  squareReceiptUrl: null,
  tenderedAmount: 250,
  changeAmount: 40,
};

const meta = {
  title: 'Features/ProcessPayment/ReceiptPreview',
  component: ReceiptPreview,
  tags: ['autodocs'],
  args: {
    onDone: () => {},
  },
} satisfies Meta<typeof ReceiptPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Cash: Story = {
  args: {
    receipt: base,
  },
};

export const Card: Story = {
  args: {
    receipt: {
      ...base,
      paymentMethod: 'card',
      tenderedAmount: undefined,
      changeAmount: undefined,
      terminalReference: 'AUTH987654',
    },
  },
};

export const Rappi: Story = {
  args: {
    receipt: {
      ...base,
      paymentMethod: 'rappi',
      // Configurable payment methods: rappi behaves exactly like card —
      // taxed normally, referenced tender, no tendered/change.
      tenderedAmount: undefined,
      changeAmount: undefined,
      terminalReference: 'RAPPI-ORDER-123',
    },
  },
};

export const UberEats: Story = {
  args: {
    receipt: {
      ...base,
      paymentMethod: 'uber_eats',
      tenderedAmount: undefined,
      changeAmount: undefined,
      terminalReference: 'UE-ORDER-456',
    },
  },
};

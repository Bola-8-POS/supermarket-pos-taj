/**
 * INVENTORY ROW STORIES
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { generateMockInventory, generateMockProduct, MOCK_IDS } from '@shared/lib/mocks';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@shared/ui/table';
import { InventoryRow } from './InventoryRow';

function InventoryTableChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>On hand</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead>Threshold</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

const meta = {
  title: 'Entities/Inventory/InventoryRow',
  component: InventoryRow,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <InventoryTableChrome>
        <Story />
      </InventoryTableChrome>
    ),
  ],
} satisfies Meta<typeof InventoryRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {
  args: {
    currentRole: 'manager',
    inventory: generateMockInventory({
      id: MOCK_IDS.invCorona,
      productId: MOCK_IDS.productCorona,
      quantityOnHand: 48,
      lowStockThreshold: 10,
      unit: 'bottles',
      product: generateMockProduct({
        id: MOCK_IDS.productCorona,
        name: 'Corona Extra',
        sku: 'CORONA-12',
      }),
    }),
  },
};

export const LowStock: Story = {
  args: {
    currentRole: 'manager',
    inventory: generateMockInventory({
      quantityOnHand: 2,
      lowStockThreshold: 5,
      unit: 'bottles',
      product: generateMockProduct({
        id: MOCK_IDS.productHeineken,
        name: 'Heineken',
        sku: 'HEIN-12',
      }),
    }),
  },
};

export const OutOfStock: Story = {
  args: {
    currentRole: 'manager',
    inventory: generateMockInventory({
      quantityOnHand: 0,
      lowStockThreshold: 3,
      unit: 'bottles',
      product: generateMockProduct({
        id: MOCK_IDS.productTitos,
        name: "Jack Daniel's",
        sku: 'JD-750',
      }),
    }),
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CartItem as CartItemType, Modifier, Product } from '@shared/lib/domain';
import { CartItem } from './CartItem';

const baseProduct: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'House Margarita',
  categoryId: '123e4567-e89b-12d3-a456-426614174099',
  basePrice: 12,
  happyHourPrice: 9,
  imageUrl: null,
  photoPath: null,
  isActive: true,
  soldByWeight: false,
  sku: 'COCKTAIL-MARG',
  stock_threshold: null,
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: true,
  isCombo: false,
  modifiers: [],
};

const shotModifier: Modifier = {
  id: '123e4567-e89b-12d3-a456-426614174030',
  name: 'Double shot',
  priceDelta: 3,
  sortOrder: 1,
};

const limeModifier: Modifier = {
  id: '123e4567-e89b-12d3-a456-426614174031',
  name: 'Extra lime',
  priceDelta: 0.5,
  sortOrder: 2,
};

function makeCartItem(overrides: Partial<CartItemType>): CartItemType {
  const product = overrides.product ?? baseProduct;
  const selectedModifiers = overrides.selectedModifiers ?? [];
  const quantity = overrides.quantity ?? 1;
  const unitPrice = overrides.unitPrice ?? product.basePrice;
  const lineTotal =
    overrides.lineTotal ??
    (unitPrice + selectedModifiers.reduce((s, m) => s + m.priceDelta, 0)) * quantity;

  return {
    tempId: overrides.tempId ?? '123e4567-e89b-12d3-a456-426614174020',
    product,
    quantity,
    selectedModifiers,
    unitPrice,
    notes: overrides.notes ?? '',
    lineTotal,
  };
}

const meta = {
  title: 'Entities/Tab/CartItem',
  component: CartItem,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    onQuantitySet: () => {},
    onRemove: () => {},
    onNotesChange: () => {},
    comboLabel: undefined,
  },
} satisfies Meta<typeof CartItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    item: makeCartItem({}),
  },
};

export const WithModifiers: Story = {
  args: {
    item: makeCartItem({
      selectedModifiers: [shotModifier, limeModifier],
      lineTotal: (12 + 3 + 0.5) * 1,
    }),
  },
};

export const MaxQuantity: Story = {
  args: {
    item: makeCartItem({
      quantity: 99,
      lineTotal: 12 * 99,
    }),
  },
};

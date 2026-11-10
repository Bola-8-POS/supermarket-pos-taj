/* eslint-disable no-console -- story actions */
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Product } from '@entities/product/model/types';
import { ModifierSchema } from '@shared/lib/domain';
import { generateMockCategory, MOCK_IDS } from '@shared/lib/mocks';
import { ModifierSheet } from './ModifierSheet';

const meta = {
  title: 'Features/AddItemToTab/ModifierSheet',
  component: ModifierSheet,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ModifierSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockCategory = generateMockCategory({
  id: MOCK_IDS.categoryBeer,
  name: 'Beer',
  happyHourStart: '16:00',
  happyHourEnd: '19:00',
});

const mockProduct: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Margarita',
  categoryId: MOCK_IDS.categoryBeer,
  basePrice: 12.0,
  happyHourPrice: 9.0,
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
  modifiers: [
    ModifierSchema.parse({
      id: 'a1000000-0000-4000-8000-000000000001',
      name: 'Salt rim',
      priceDelta: 0,
      sortOrder: 0,
    }),
    ModifierSchema.parse({
      id: 'a1000000-0000-4000-8000-000000000002',
      name: 'Premium tequila',
      priceDelta: 3.5,
      sortOrder: 1,
    }),
  ],
  category: mockCategory,
};

export const Default: Story = {
  args: {
    product: mockProduct,
    open: true,
    onConfirm: modifiers => {
      console.log('Confirmed modifiers:', modifiers);
    },
    onClose: () => {
      console.log('Closed');
    },
  },
};

export const Closed: Story = {
  args: {
    product: mockProduct,
    open: false,
    onConfirm: modifiers => {
      console.log('Confirmed modifiers:', modifiers);
    },
    onClose: () => {
      console.log('Closed');
    },
  },
};

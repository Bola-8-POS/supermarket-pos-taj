/* eslint-disable no-console -- story actions */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { generateMockCategory, generateMockProduct, MOCK_IDS } from '@shared/lib/mocks';
import { ProductCard } from './ProductCard';

const meta = {
  title: 'Entities/Product/ProductCard',
  component: ProductCard,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <div className="max-w-xs">
        <Story />
      </div>
    ),
  ],
  args: {
    onSelect: p => {
      console.log('selected', p.name);
    },
  },
} satisfies Meta<typeof ProductCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const defaultCategory = generateMockCategory({
  id: MOCK_IDS.categoryBeer,
  name: 'Beer',
  color: '#f59e0b',
  happyHourStart: '16:00',
  happyHourEnd: '19:00',
});

const defaultProduct = generateMockProduct({
  categoryId: defaultCategory.id,
  category: defaultCategory,
  name: 'Heineken',
  basePrice: 7.0,
  happyHourPrice: 5.5,
  isActive: true,
});

export const Default: Story = {
  args: {
    product: defaultProduct,
    category: defaultCategory,
    now: new Date('2024-06-15T14:00:00'),
  },
};

export const HappyHour: Story = {
  args: {
    product: defaultProduct,
    category: defaultCategory,
    now: new Date('2024-06-15T17:00:00'),
  },
};

export const OutOfStock: Story = {
  args: {
    product: generateMockProduct({
      ...defaultProduct,
      isActive: false,
    }),
    category: defaultCategory,
    now: new Date('2024-06-15T17:00:00'),
  },
};

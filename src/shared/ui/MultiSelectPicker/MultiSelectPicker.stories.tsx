/* eslint-disable no-console -- story actions */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  MultiSelectPicker,
  type MultiSelectCategoryItem,
  type MultiSelectProductItem,
} from './MultiSelectPicker';

// ============================================================================
// MOCK DATA
// ============================================================================

const PRODUCTS: MultiSelectProductItem[] = [
  { id: 'p-atta', name: 'Aashirvaad Atta 5kg' },
  { id: 'p-basmati', name: 'India Gate Basmati Rice 5kg' },
  { id: 'p-toor', name: 'Toor Dal 1kg' },
  { id: 'p-ghee', name: 'Amul Pure Ghee 1L' },
  { id: 'p-tea', name: 'Red Label Tea 500g' },
  { id: 'p-haldiram', name: 'Haldiram Bhujia Sev — a genuinely extremely long product name for truncation testing' },
];

const ROOT_STAPLES: MultiSelectCategoryItem = { id: 'c-staples', parentId: null, name: 'Staples' };
const ROOT_SNACKS: MultiSelectCategoryItem = { id: 'c-snacks', parentId: null, name: 'Snacks' };
const CHILD_RICE: MultiSelectCategoryItem = { id: 'c-rice', parentId: 'c-staples', name: 'Rice & Grains' };
const CHILD_LENTILS: MultiSelectCategoryItem = { id: 'c-lentils', parentId: 'c-staples', name: 'Lentils & Pulses' };

const CATEGORIES: MultiSelectCategoryItem[] = [
  ROOT_STAPLES,
  ROOT_SNACKS,
  CHILD_RICE,
  CHILD_LENTILS,
];

// ============================================================================
// INTERACTIVE WRAPPER
// ============================================================================

function ControlledWrapper() {
  const [productIds, setProductIds] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  return (
    <div className="flex flex-col gap-4">
      <MultiSelectPicker
        products={PRODUCTS}
        categories={CATEGORIES}
        selectedProductIds={productIds}
        selectedCategoryIds={categoryIds}
        onChange={next => {
          setProductIds(next.productIds);
          setCategoryIds(next.categoryIds);
          console.log('onChange', next);
        }}
      />
      <p className="text-sm text-muted-foreground">
        Selected products: <code>{productIds.join(', ') || 'none'}</code>
        <br />
        Selected categories: <code>{categoryIds.join(', ') || 'none'}</code>
      </p>
    </div>
  );
}

// ============================================================================
// META
// ============================================================================

const meta = {
  title: 'Shared/UI/MultiSelectPicker',
  component: MultiSelectPicker,
  parameters: {
    layout: 'padded',
    backgrounds: { default: 'dark' },
  },
  tags: ['autodocs'],
  args: {
    products: PRODUCTS,
    categories: CATEGORIES,
    selectedProductIds: [],
    selectedCategoryIds: [],
    onChange: (next: { productIds: string[]; categoryIds: string[] }) => {
      console.log('onChange', next);
    },
  },
} satisfies Meta<typeof MultiSelectPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

// ============================================================================
// STORIES
// ============================================================================

export const Empty: Story = {};

export const SomeProductsSelected: Story = {
  args: {
    selectedProductIds: ['p-atta', 'p-basmati'],
  },
};

export const SomeCategoriesSelected: Story = {
  args: {
    selectedCategoryIds: ['c-staples', 'c-rice'],
  },
};

export const MixedSelectionWithOverflow: Story = {
  args: {
    selectedProductIds: PRODUCTS.map(p => p.id),
    selectedCategoryIds: CATEGORIES.map(c => c.id),
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    selectedProductIds: ['p-atta'],
  },
};

export const Interactive: Story = {
  render: () => <ControlledWrapper />,
};

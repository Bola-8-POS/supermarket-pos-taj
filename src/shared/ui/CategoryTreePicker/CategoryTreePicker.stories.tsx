/* eslint-disable no-console -- story actions */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { CategoryTreePicker, type CategoryPickerItem } from './CategoryTreePicker';

// ============================================================================
// MOCK DATA
// ============================================================================

const ROOT_1: CategoryPickerItem = {
  id: 'root-beer',
  parentId: null,
  name: 'Beer',
  color: '#FFA500',
};
const ROOT_2: CategoryPickerItem = {
  id: 'root-cocktails',
  parentId: null,
  name: 'Cocktails',
  color: '#FF1493',
};
const ROOT_3: CategoryPickerItem = {
  id: 'root-food',
  parentId: null,
  name: 'Food',
  color: '#22c55e',
};

const CHILD_1: CategoryPickerItem = {
  id: 'child-lager',
  parentId: 'root-beer',
  name: 'Lager',
  color: '#fbbf24',
};
const CHILD_2: CategoryPickerItem = {
  id: 'child-stout',
  parentId: 'root-beer',
  name: 'Stout',
  color: '#92400e',
};
const CHILD_3: CategoryPickerItem = {
  id: 'child-tropical',
  parentId: 'root-cocktails',
  name: 'Tropical',
  color: '#ec4899',
};
const CHILD_4: CategoryPickerItem = {
  id: 'child-starters',
  parentId: 'root-food',
  name: 'Starters',
  color: '#86efac',
};

const GRAND_1: CategoryPickerItem = {
  id: 'grand-pale-lager',
  parentId: 'child-lager',
  name: 'Pale Lager',
  color: '#fef08a',
};

const FLAT_ITEMS: CategoryPickerItem[] = [
  ROOT_1,
  ROOT_2,
  ROOT_3,
  CHILD_1,
  CHILD_2,
  CHILD_3,
  CHILD_4,
  GRAND_1,
];

// ============================================================================
// INTERACTIVE WRAPPER
// ============================================================================

function ControlledWrapper({ initial = null }: { initial?: string | null }) {
  const [selected, setSelected] = useState<string | null>(initial);
  return (
    <div className="flex flex-col gap-4">
      <CategoryTreePicker
        items={FLAT_ITEMS}
        value={selected}
        onChange={id => {
          setSelected(id);
          console.log('selected', id);
        }}
      />
      <p className="text-sm text-muted-foreground">
        Selected: <code>{selected ?? 'none'}</code>
      </p>
    </div>
  );
}

// ============================================================================
// META
// ============================================================================

const meta = {
  title: 'Shared/UI/CategoryTreePicker',
  component: CategoryTreePicker,
  parameters: {
    layout: 'padded',
    backgrounds: { default: 'dark' },
  },
  tags: ['autodocs'],
  args: {
    items: FLAT_ITEMS,
    value: null,
    onChange: (id: string | null) => {
      console.log('onChange', id);
    },
  },
} satisfies Meta<typeof CategoryTreePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

// ============================================================================
// STORIES
// ============================================================================

export const Default: Story = {};

export const WithSelection: Story = {
  args: {
    value: 'child-lager',
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    value: 'root-beer',
  },
};

export const EmptyList: Story = {
  args: {
    items: [],
    emptyText: 'No categories have been configured yet.',
  },
};

export const Interactive: Story = {
  render: () => <ControlledWrapper />,
};

export const FlatRootsOnly: Story = {
  args: {
    items: [ROOT_1, ROOT_2, ROOT_3],
    value: null,
  },
};

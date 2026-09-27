import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable, type DataTableProps } from './DataTable';

type Row = { id: string; name: string; amount: number };

// Storybook's Meta/StoryObj typing loses the generic `T` when pointed
// directly at a generic function component (`typeof DataTable<Row>`
// resolves args to `DataTableProps<unknown>`). A concrete wrapper keeps
// full type-safety for the story args without touching DataTable itself.
function DataTableStory(props: DataTableProps<Row>) {
  return <DataTable {...props} />;
}

const columns: ColumnDef<Row>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
  },
  {
    id: 'amount',
    accessorKey: 'amount',
    header: 'Amount',
  },
];

const data: Row[] = [
  { id: '1', name: 'Basmati Rice 5kg', amount: 12.5 },
  { id: '2', name: 'Toor Dal 1kg', amount: 3.99 },
  { id: '3', name: 'Ghee 500ml', amount: 8.25 },
];

/**
 * DataTable component
 *
 * Generic table wrapper using TanStack Table, with loading and empty states.
 */
const meta = {
  title: 'Shared/UI/DataTable',
  component: DataTableStory,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof DataTableStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    columns,
    data,
  },
};

export const Loading: Story = {
  args: {
    columns,
    data: [],
    isLoading: true,
  },
};

export const Empty: Story = {
  args: {
    columns,
    data: [],
    isLoading: false,
  },
};

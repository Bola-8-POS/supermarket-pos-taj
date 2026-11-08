import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from './EmptyState';

/**
 * EmptyState component
 *
 * Centered empty state with icon, title, description, and optional action.
 * Used when lists or tables have no data.
 */
const meta = {
  title: 'Shared/UI/EmptyState',
  component: EmptyState,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: FileQuestion,
    title: 'No results',
    description: 'Try adjusting your filters',
  },
};

export const WithAction: Story = {
  args: {
    icon: FileQuestion,
    title: 'No results',
    description: 'Try adjusting your filters',
    action: {
      label: 'Add item',
      onClick: () => {},
    },
  },
};

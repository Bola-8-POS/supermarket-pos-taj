import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * ConfirmDialog component
 *
 * Confirmation dialog with destructive variant support.
 * Wraps shadcn AlertDialog with consistent styling.
 */
const meta = {
  title: 'Shared/UI/ConfirmDialog',
  component: ConfirmDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
    title: 'Confirm action',
    description: 'Are you sure?',
    onConfirm: () => {},
    onCancel: () => {},
  },
};

export const Destructive: Story = {
  args: {
    open: true,
    title: 'Confirm action',
    description: 'Are you sure?',
    variant: 'destructive',
    confirmLabel: 'Delete',
    onConfirm: () => {},
    onCancel: () => {},
  },
};

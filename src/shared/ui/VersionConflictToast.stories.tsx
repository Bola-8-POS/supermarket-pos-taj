import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toaster } from 'sonner';
import { VersionConflictToast } from './VersionConflictToast';

const meta: Meta<typeof VersionConflictToast> = {
  title: 'Shared/UI/VersionConflictToast',
  component: VersionConflictToast,
  tags: ['autodocs'],
  decorators: [
    Story => (
      <div>
        <Toaster richColors closeButton position="top-right" />
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof VersionConflictToast>;

/** Stale-version variant — emitted when another terminal updated the row first. */
export const StaleVersion: Story = {
  args: { variant: 'stale' },
};

/** Not-found-versioned variant — emitted when another terminal deleted the row. */
export const NotFoundVersioned: Story = {
  args: { variant: 'not-found' },
};

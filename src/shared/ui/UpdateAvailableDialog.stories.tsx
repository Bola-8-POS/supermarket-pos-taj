import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdateAvailableDialog } from './UpdateAvailableDialog';

const meta: Meta<typeof UpdateAvailableDialog> = {
  title: 'shared/ui/UpdateAvailableDialog',
  component: UpdateAvailableDialog,
  parameters: { layout: 'centered' },
  args: {
    onInstall: async () => { /* no-op */ },
    onRemindLater: () => {},
    onDismiss: () => {},
    onRestart: async () => { /* no-op */ },
  },
};

export default meta;
type Story = StoryObj<typeof UpdateAvailableDialog>;

export const Default: Story = {
  args: {
    state: {
      phase: 'available',
      version: 'v2.1.0',
      changelog:
        '- New auto-updater with one-click install\n- Bug fixes and performance improvements\n- Improved pool table timer accuracy',
    },
  },
};

export const Downloading: Story = {
  args: {
    state: { phase: 'downloading', version: 'v2.1.0', percent: 42 },
  },
};

export const RestartReady: Story = {
  args: {
    state: { phase: 'restart-ready', version: 'v2.1.0' },
  },
};

export const ErrorState: Story = {
  args: {
    state: { phase: 'error' },
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useStoreSchemaStore } from '@shared/lib/store-schema/store';
import { StoreUpdatingBanner } from './StoreUpdatingBanner';

/** Non-blocking strip shown while the store server is fenced for an update. */
const meta = {
  title: 'Shared/UI/StoreUpdatingBanner',
  component: StoreUpdatingBanner,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoreUpdatingBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Updating: Story = {
  decorators: [
    Story => {
      useStoreSchemaStore.setState({ state: { kind: 'updating' }, checkedAt: Date.now() });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    if (!canvasElement.querySelector('[data-testid="store-updating-banner"]')) {
      throw new Error('banner not rendered');
    }
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { RoutingBadge } from './RoutingBadge';

const meta: Meta<typeof RoutingBadge> = {
  title: 'Shared/UI/RoutingBadge',
  component: RoutingBadge,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof RoutingBadge>;

export const Kitchen: Story = {
  args: { routing: 'KITCHEN' },
};

export const Bar: Story = {
  args: { routing: 'BAR' },
};

export const None: Story = {
  args: { routing: 'NONE' },
};

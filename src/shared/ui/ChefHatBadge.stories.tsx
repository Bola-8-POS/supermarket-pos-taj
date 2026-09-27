import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChefHatBadge } from './ChefHatBadge';

const meta: Meta<typeof ChefHatBadge> = {
  title: 'Shared/UI/ChefHatBadge',
  component: ChefHatBadge,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof ChefHatBadge>;

export const Default: Story = {};

export const InlineWithText: Story = {
  render: () => (
    <span className="flex items-center gap-2 text-sm">
      Salsa Mexicana
      <ChefHatBadge />
    </span>
  ),
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { MoneyDisplay } from './MoneyDisplay';

/**
 * MoneyDisplay component
 *
 * Displays formatted, locale-aware money amounts with proper styling.
 */
const meta = {
  title: 'Shared/UI/MoneyDisplay',
  component: MoneyDisplay,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg', 'xl'],
    },
  },
} satisfies Meta<typeof MoneyDisplay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Positive: Story = {
  args: {
    amount: 42.5,
  },
};

export const Negative: Story = {
  args: {
    amount: -12.99,
  },
};

export const Large: Story = {
  args: {
    amount: 199.99,
    size: 'xl',
  },
};

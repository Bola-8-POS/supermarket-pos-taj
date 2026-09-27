import type { Meta, StoryObj } from '@storybook/react-vite';
import { POSButton } from './POSButton';

/**
 * POSButton component
 *
 * Extended Button optimized for POS touchscreen use — larger touch targets
 * and press animations.
 */
const meta = {
  title: 'Shared/UI/POSButton',
  component: POSButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    touchSize: {
      control: 'select',
      options: ['default', 'large', 'xl'],
    },
  },
} satisfies Meta<typeof POSButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Process Payment',
    touchSize: 'default',
  },
};

export const XLarge: Story = {
  args: {
    children: 'Process Payment',
    touchSize: 'xl',
  },
};

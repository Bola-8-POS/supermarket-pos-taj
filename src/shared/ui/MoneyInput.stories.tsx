import type { Meta, StoryObj } from '@storybook/react-vite';
import { MoneyInput } from './MoneyInput';

/**
 * MoneyInput component
 *
 * Currency input that stores values as integer cents to avoid floating point
 * issues, always displaying formatted with 2 decimal places.
 */
const meta = {
  title: 'Shared/UI/MoneyInput',
  component: MoneyInput,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MoneyInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: 0,
    onChange: () => {},
    placeholder: '0.00',
  },
};

export const Labeled: Story = {
  args: {
    value: 0,
    onChange: () => {},
    placeholder: '0.00',
    label: 'Amount',
  },
};

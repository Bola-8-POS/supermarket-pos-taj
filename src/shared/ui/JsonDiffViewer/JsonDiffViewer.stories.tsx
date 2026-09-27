import type { Meta, StoryObj } from '@storybook/react-vite';

import { JsonDiffViewer } from './JsonDiffViewer';

const meta: Meta<typeof JsonDiffViewer> = {
  title: 'Shared/JsonDiffViewer',
  component: JsonDiffViewer,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof JsonDiffViewer>;

export const Added: Story = {
  args: {
    before: { amount: 150, method: 'cash' },
    after: { amount: 150, method: 'cash', tip: 20 },
  },
};

export const Removed: Story = {
  args: {
    before: { amount: 150, method: 'cash', discount: 10 },
    after: { amount: 150, method: 'cash' },
  },
};

export const Modified: Story = {
  args: {
    before: { status: 'open', amount: 100 },
    after: { status: 'closed', amount: 100 },
  },
};

export const DeeplyNested: Story = {
  args: {
    before: { tab: { id: 'abc', items: [{ qty: 1, price: 50 }] } },
    after: { tab: { id: 'abc', items: [{ qty: 2, price: 50 }] } },
  },
};

export const Truncated: Story = {
  args: {
    before: { _truncated: true, _reason: 'payload exceeded 64KB' },
    after: { status: 'closed' },
    truncated: true,
  },
};

export const BothEmpty: Story = {
  args: {
    before: null,
    after: null,
  },
};

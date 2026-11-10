/**
 * TYPOGRAPHY STORY
 *
 * Visual reference for all text size/weight combinations.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design Tokens/Typography',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const TypeSample = ({
  label,
  className,
  text = 'The quick brown fox jumps over the lazy dog',
}: {
  label: string;
  className: string;
  text?: string;
}) => (
  <div className="space-y-2 border-b pb-4">
    <div className="flex items-baseline justify-between">
      <span className="text-sm font-mono text-muted-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{className}</span>
    </div>
    <div className={className}>{text}</div>
  </div>
);

export const AllTypography: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h2 className="mb-4 text-2xl font-bold">Display</h2>
        <div className="space-y-4">
          <TypeSample label="Display 3XL" className="text-3xl font-bold" text="$1,234.56" />
          <TypeSample label="Display 2XL" className="text-2xl font-bold" text="$1,234.56" />
          <TypeSample label="Display XL" className="text-xl font-bold" text="$1,234.56" />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Headings</h2>
        <div className="space-y-4">
          <TypeSample label="Heading LG" className="text-lg font-semibold" text="Open Tabs" />
          <TypeSample
            label="Heading Base"
            className="text-base font-semibold"
            text="Customer Name"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Body</h2>
        <div className="space-y-4">
          <TypeSample
            label="Body Base"
            className="text-base"
            text="The quick brown fox jumps over the lazy dog"
          />
          <TypeSample
            label="Body Base Medium"
            className="text-base font-medium"
            text="The quick brown fox jumps over the lazy dog"
          />
          <TypeSample
            label="Body SM"
            className="text-sm"
            text="The quick brown fox jumps over the lazy dog"
          />
          <TypeSample
            label="Body SM Medium"
            className="text-sm font-medium"
            text="The quick brown fox jumps over the lazy dog"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Caption</h2>
        <div className="space-y-4">
          <TypeSample label="Caption XS" className="text-xs" text="Last updated 5 minutes ago" />
          <TypeSample
            label="Caption XS Medium"
            className="text-xs font-medium"
            text="Last updated 5 minutes ago"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Monospace (Timers, Codes)</h2>
        <div className="space-y-4">
          <TypeSample label="Mono Base" className="font-mono text-base" text="01:23:45" />
          <TypeSample label="Mono LG" className="font-mono text-lg" text="01:23:45" />
          <TypeSample label="Mono XL" className="font-mono text-xl" text="01:23:45" />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Muted Text</h2>
        <div className="space-y-4">
          <TypeSample
            label="Muted Base"
            className="text-base text-muted-foreground"
            text="Secondary information"
          />
          <TypeSample
            label="Muted SM"
            className="text-sm text-muted-foreground"
            text="Hint or helper text"
          />
          <TypeSample
            label="Muted XS"
            className="text-xs text-muted-foreground"
            text="Metadata or timestamps"
          />
        </div>
      </div>
    </div>
  ),
};

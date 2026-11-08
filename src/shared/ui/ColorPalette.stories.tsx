/**
 * COLOR PALETTE STORY
 *
 * Visual reference for all Tailwind colors used in the POS.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design Tokens/Color Palette',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ColorSwatch = ({
  name,
  variable,
  description,
}: {
  name: string;
  variable: string;
  description: string;
}) => (
  <div className="flex items-center gap-4 rounded-lg border p-4">
    <div
      className="h-16 w-16 rounded-md border"
      style={{ backgroundColor: `hsl(var(${variable}))` }}
    />
    <div className="flex-1">
      <div className="font-semibold">{name}</div>
      <div className="text-sm text-muted-foreground">{variable}</div>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
  </div>
);

export const AllColors: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h2 className="mb-4 text-2xl font-bold">Primary Colors</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ColorSwatch
            name="Background"
            variable="--background"
            description="Main background color"
          />
          <ColorSwatch name="Foreground" variable="--foreground" description="Main text color" />
          <ColorSwatch name="Card" variable="--card" description="Card background" />
          <ColorSwatch
            name="Card Foreground"
            variable="--card-foreground"
            description="Card text color"
          />
          <ColorSwatch name="Popover" variable="--popover" description="Popover background" />
          <ColorSwatch
            name="Popover Foreground"
            variable="--popover-foreground"
            description="Popover text color"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Action Colors</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ColorSwatch name="Primary" variable="--primary" description="Primary action color" />
          <ColorSwatch
            name="Primary Foreground"
            variable="--primary-foreground"
            description="Text on primary"
          />
          <ColorSwatch
            name="Secondary"
            variable="--secondary"
            description="Secondary action color"
          />
          <ColorSwatch
            name="Secondary Foreground"
            variable="--secondary-foreground"
            description="Text on secondary"
          />
          <ColorSwatch name="Muted" variable="--muted" description="Muted background" />
          <ColorSwatch
            name="Muted Foreground"
            variable="--muted-foreground"
            description="Muted text"
          />
          <ColorSwatch name="Accent" variable="--accent" description="Accent color" />
          <ColorSwatch
            name="Accent Foreground"
            variable="--accent-foreground"
            description="Text on accent"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Status Colors</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ColorSwatch
            name="Destructive"
            variable="--destructive"
            description="Dangerous actions (void, delete)"
          />
          <ColorSwatch
            name="Destructive Foreground"
            variable="--destructive-foreground"
            description="Text on destructive"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Border & Input</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ColorSwatch name="Border" variable="--border" description="Default border color" />
          <ColorSwatch name="Input" variable="--input" description="Input border color" />
          <ColorSwatch name="Ring" variable="--ring" description="Focus ring color" />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Semantic Colors</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex items-center gap-4 rounded-lg border p-4">
            <div className="h-16 w-16 rounded-md border bg-green-500" />
            <div className="flex-1">
              <div className="font-semibold">Success / Open / Available</div>
              <div className="text-sm text-muted-foreground">bg-green-500</div>
              <div className="text-xs text-muted-foreground">Open tabs, available tables</div>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-lg border p-4">
            <div className="h-16 w-16 rounded-md border bg-yellow-500" />
            <div className="flex-1">
              <div className="font-semibold">Warning / Occupied</div>
              <div className="text-sm text-muted-foreground">bg-yellow-500</div>
              <div className="text-xs text-muted-foreground">Occupied tables, warnings</div>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-lg border p-4">
            <div className="h-16 w-16 rounded-md border bg-red-500" />
            <div className="flex-1">
              <div className="font-semibold">Error / Voided</div>
              <div className="text-sm text-muted-foreground">bg-red-500</div>
              <div className="text-xs text-muted-foreground">Voided orders, errors</div>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-lg border p-4">
            <div className="h-16 w-16 rounded-md border bg-blue-500" />
            <div className="flex-1">
              <div className="font-semibold">Info / Paid</div>
              <div className="text-sm text-muted-foreground">bg-blue-500</div>
              <div className="text-xs text-muted-foreground">Paid tabs, info messages</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  ),
};

/**
 * SPACING STORY
 *
 * Visual reference for the spacing scale.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Design Tokens/Spacing',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SpacingSample = ({ value, pixels, rem }: { value: string; pixels: string; rem: string }) => (
  <div className="flex items-center gap-4 border-b pb-4">
    <div className="w-20 font-mono text-sm">{value}</div>
    <div className="w-24 text-sm text-muted-foreground">
      {pixels} / {rem}
    </div>
    <div className="h-8 bg-primary" style={{ width: pixels }} />
  </div>
);

export const AllSpacing: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h2 className="mb-4 text-2xl font-bold">Spacing Scale</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          Base unit: 4px (0.25rem). All spacing values are multiples of the base unit.
        </p>
        <div className="space-y-4">
          <SpacingSample value="0" pixels="0px" rem="0rem" />
          <SpacingSample value="1" pixels="4px" rem="0.25rem" />
          <SpacingSample value="2" pixels="8px" rem="0.5rem" />
          <SpacingSample value="3" pixels="12px" rem="0.75rem" />
          <SpacingSample value="4" pixels="16px" rem="1rem" />
          <SpacingSample value="5" pixels="20px" rem="1.25rem" />
          <SpacingSample value="6" pixels="24px" rem="1.5rem" />
          <SpacingSample value="8" pixels="32px" rem="2rem" />
          <SpacingSample value="10" pixels="40px" rem="2.5rem" />
          <SpacingSample value="12" pixels="48px" rem="3rem" />
          <SpacingSample value="16" pixels="64px" rem="4rem" />
          <SpacingSample value="20" pixels="80px" rem="5rem" />
          <SpacingSample value="24" pixels="96px" rem="6rem" />
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Common Usage</h2>
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="font-semibold">gap-1 (4px)</div>
            <div className="text-sm text-muted-foreground">
              Tight spacing between related elements (icon + text)
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">gap-2 (8px)</div>
            <div className="text-sm text-muted-foreground">
              Default spacing between elements in a group
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">gap-4 (16px)</div>
            <div className="text-sm text-muted-foreground">Spacing between sections or cards</div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">gap-6 (24px)</div>
            <div className="text-sm text-muted-foreground">
              Large spacing between major sections
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">p-4 (16px)</div>
            <div className="text-sm text-muted-foreground">
              Default padding for cards and containers
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">p-6 (24px)</div>
            <div className="text-sm text-muted-foreground">Page container padding</div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-2xl font-bold">Touch Targets</h2>
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="font-semibold">44px (11 units)</div>
            <div className="text-sm text-muted-foreground">
              Minimum touch target for mobile (WCAG 2.1 Level AAA)
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">56px (14 units)</div>
            <div className="text-sm text-muted-foreground">
              Comfortable touch target for bartenders (POSButton large)
            </div>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold">64px (16 units)</div>
            <div className="text-sm text-muted-foreground">
              Large touch target for primary actions (POSButton xl, PINKeypad)
            </div>
          </div>
        </div>
      </div>
    </div>
  ),
};

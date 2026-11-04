import type { Meta, StoryObj } from '@storybook/react-vite';
import { DatabaseBackup, Languages, Mail, Printer, Store } from 'lucide-react';
import { Tabs, TabsContent } from './tabs';
import { VerticalTabsGroupLabel, VerticalTabsList, VerticalTabsTrigger } from './vertical-tabs';

/**
 * VerticalTabs — grouped left-rail navigation used by Settings and Reports.
 * Collapses to a horizontal scrolling row below the `lg` breakpoint.
 */
const meta = {
  title: 'Shared/UI/VerticalTabs',
  component: VerticalTabsTrigger,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof VerticalTabsTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {
  args: { value: 'general', label: 'General' },
  render: () => (
    <Tabs
      defaultValue="general"
      orientation="vertical"
      className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <VerticalTabsList aria-label="Settings sections" className="self-start">
        <VerticalTabsGroupLabel>Personal</VerticalTabsGroupLabel>
        <VerticalTabsTrigger
          value="language"
          icon={Languages}
          label="Language"
          description="Interface language for your account"
        />
        <VerticalTabsGroupLabel>Store</VerticalTabsGroupLabel>
        <VerticalTabsTrigger
          value="general"
          icon={Store}
          label="General"
          description="Name, address, timezone"
        />
        <VerticalTabsGroupLabel>Receipts & hardware</VerticalTabsGroupLabel>
        <VerticalTabsTrigger
          value="hardware"
          icon={Printer}
          label="Hardware"
          description="Printer, paper, drawer"
        />
        <VerticalTabsTrigger
          value="email"
          icon={Mail}
          label="Email Receipts"
          description="Sender and test email"
        />
        <VerticalTabsGroupLabel>Security & data</VerticalTabsGroupLabel>
        <VerticalTabsTrigger
          value="backup"
          icon={DatabaseBackup}
          label="Backup"
          description="Snapshots and restore"
        />
      </VerticalTabsList>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-xs">
        <TabsContent value="language">Language body</TabsContent>
        <TabsContent value="general">General body</TabsContent>
        <TabsContent value="hardware">Hardware body</TabsContent>
        <TabsContent value="email">Email body</TabsContent>
        <TabsContent value="backup">Backup body</TabsContent>
      </div>
    </Tabs>
  ),
};

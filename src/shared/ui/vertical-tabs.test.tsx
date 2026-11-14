import { render, screen } from '@testing-library/react';
import { Printer } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent } from './tabs';
import { VerticalTabsGroupLabel, VerticalTabsList, VerticalTabsTrigger } from './vertical-tabs';

function Fixture() {
  return (
    <Tabs defaultValue="hardware" orientation="vertical">
      <VerticalTabsList aria-label="Settings sections">
        <VerticalTabsGroupLabel>Receipts</VerticalTabsGroupLabel>
        <VerticalTabsTrigger
          value="hardware"
          icon={Printer}
          label="Hardware"
          description="Printer, paper width and drawer"
        />
        <VerticalTabsTrigger value="email" label="Email Receipts" />
      </VerticalTabsList>
      <TabsContent value="hardware">Hardware body</TabsContent>
      <TabsContent value="email">Email body</TabsContent>
    </Tabs>
  );
}

describe('VerticalTabs', () => {
  it('exposes each trigger as a tab whose accessible name is the label only', () => {
    render(<Fixture />);
    expect(screen.getByRole('tab', { name: 'Hardware' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Email Receipts' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /paper width/i })).not.toBeInTheDocument();
  });

  it('marks the default tab active and renders its panel', () => {
    render(<Fixture />);
    expect(screen.getByRole('tab', { name: 'Hardware' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Hardware body')).toBeInTheDocument();
  });

  it('renders the group label as decorative text', () => {
    render(<Fixture />);
    expect(screen.getByText('Receipts')).toHaveAttribute('aria-hidden', 'true');
  });

  it('excludes a text-bearing badge from the accessible name', () => {
    render(
      <Tabs defaultValue="hardware" orientation="vertical">
        <VerticalTabsList aria-label="Settings sections">
          <VerticalTabsTrigger value="hardware" label="Hardware" badge={<span>7</span>} />
        </VerticalTabsList>
        <TabsContent value="hardware">Hardware body</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tab', { name: 'Hardware' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /7/ })).not.toBeInTheDocument();
  });
});

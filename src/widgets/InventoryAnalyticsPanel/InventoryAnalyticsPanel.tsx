import { ExpiryLossSection } from './ExpiryLossSection';
import { ShrinkageWasteSection } from './ShrinkageWasteSection';
import { TurnoverSection } from './TurnoverSection';
import { ValuationSection } from './ValuationSection';

type Props = {
  dateRange: { from: Date; to: Date };
};

/**
 * Thin composer for the "Inventory Analytics" Reports-page tab (D-06).
 * Valuation is the tracer slice (Plan 14-01); Shrinkage-Waste and
 * Expiry-Loss are added by Plan 14-03; Turnover is added by 14-04 as the
 * fourth and final section.
 */
export function InventoryAnalyticsPanel({ dateRange }: Props) {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <ValuationSection dateRange={dateRange} />
      <ShrinkageWasteSection dateRange={dateRange} />
      <ExpiryLossSection dateRange={dateRange} />
      <TurnoverSection dateRange={dateRange} />
    </div>
  );
}

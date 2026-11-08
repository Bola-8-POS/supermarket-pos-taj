import { useTranslation } from 'react-i18next';
import type { Tab } from '@entities/tab/model/types';
import { cn } from '@shared/lib/utils';
import { MoneyDisplay, POSButton } from '@shared/ui';

export interface TabPaymentCardProps {
  tab: Tab;
  selected: boolean;
  onClick: () => void;
}

function calculateSubtotal(tab: Tab): number {
  const itemsTotal = tab.items.reduce(
    (sum, item) => sum + (item.unitPrice + item.modifierPriceDelta) * item.quantity,
    0
  );
  return Math.round(itemsTotal * 100) / 100;
}

export function TabPaymentCard({ tab, selected, onClick }: TabPaymentCardProps) {
  const { t } = useTranslation('wPanels');
  const subtotal = calculateSubtotal(tab);
  const itemCount = tab.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <POSButton
      type="button"
      variant="ghost"
      touchSize="large"
      aria-label={`tab ${tab.customerName}`}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'w-full flex-col items-stretch justify-start rounded-xl border border-border bg-card p-3.5 text-left shadow-xs transition-[border-color,box-shadow,background-color] hover:border-border-strong hover:bg-card',
        selected && 'border-brand bg-brand-soft/40 ring-2 ring-brand/30 hover:bg-brand-soft/40'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{tab.customerName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('tabPaymentCard.itemCount', { count: itemCount })}
          </p>
        </div>
        <MoneyDisplay amount={subtotal} size="sm" className="shrink-0 font-semibold" />
      </div>
    </POSButton>
  );
}

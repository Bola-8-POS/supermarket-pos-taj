import { AlertCircle, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTabs } from '@entities/tab/model/queries';
import type { Tab } from '@entities/tab/model/types';
import { EmptyState, ScrollArea, TabListSkeleton } from '@shared/ui';
import { TabPaymentCard } from './TabPaymentCard';

export interface TabPaymentListProps {
  selectedTabId: string | undefined;
  onSelect: (tab: Tab) => void;
}

function sortTabs(tabs: Tab[]): Tab[] {
  return [...tabs].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}

export function TabPaymentList({ selectedTabId, onSelect }: TabPaymentListProps) {
  const { t } = useTranslation('wPanels');
  const { data: tabs, isIdleOrLoading, resultError } = useTabs();

  const openTabs = sortTabs((tabs ?? []).filter(t => t.status === 'open'));

  if (isIdleOrLoading) {
    return (
      <div className="p-3">
        <TabListSkeleton count={4} />
      </div>
    );
  }

  if (resultError) {
    return (
      <div className="p-3">
        <EmptyState
          icon={AlertCircle}
          title={t('tabPaymentList.couldNotLoadTabs')}
          description={resultError.message}
        />
      </div>
    );
  }

  if (openTabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={CreditCard}
          title={t('tabPaymentList.noTabsWaiting')}
          description={t('tabPaymentList.allOpenTabsAppearHere')}
        />
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-hidden"
      aria-label={t('tabPaymentList.tabsWaitingForPaymentAriaLabel')}
      data-testid="tabs-waiting-for-payment"
    >
      <ScrollArea className="h-full">
        <div className="space-y-2 p-3">
          {openTabs.map(tab => (
            <TabPaymentCard
              key={tab.id}
              tab={tab}
              selected={tab.id === selectedTabId}
              onClick={() => {
                onSelect(tab);
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

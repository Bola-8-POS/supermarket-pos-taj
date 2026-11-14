import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BankTransfersList } from '@widgets/BankTransfersList';
import { PaymentPane } from '@widgets/PaymentPane';
import { RefundsList } from '@widgets/RefundsList';
import { OfflineSalesDialog } from '@features/review-offline-sales';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { PageContainer, POSButton } from '@shared/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@shared/ui/tabs';

type PaymentsTab = 'payments' | 'refunds' | 'bankTransfers';

export default function PaymentsPage() {
  const { t } = useTranslation('pages');
  const [tab, setTab] = useState<PaymentsTab>('payments');
  // Confirmed offline sales are kept 48 h for reprint, so the way in does not depend on anything pending.
  const hasOfflineSales = useOfflineSaleStore(s => s.records.length > 0);
  const [offlineOpen, setOfflineOpen] = useState(false);
  return (
    <PageContainer title={t('payments.title')} width="fluid" flush>
      <Tabs
        value={tab}
        onValueChange={value => {
          setTab(value as PaymentsTab);
        }}
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
      >
        <div className="shrink-0 border-b border-border bg-background px-6 py-3 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="payments">{t('payments.tabs.payments')}</TabsTrigger>
              <TabsTrigger value="refunds">{t('payments.tabs.refunds')}</TabsTrigger>
              <TabsTrigger value="bankTransfers">{t('payments.tabs.bankTransfers')}</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground">{t(`payments.descriptions.${tab}`)}</p>
              {hasOfflineSales ? (
                <POSButton
                  type="button"
                  variant="outline"
                  focusEmphasis="high"
                  data-testid="offline-sales-open-history"
                  onClick={() => {
                    setOfflineOpen(true);
                  }}
                >
                  {t('payments.offlineSales')}
                </POSButton>
              ) : null}
            </div>
          </div>
        </div>
        <TabsContent value="payments" className="flex min-h-0 flex-1 overflow-hidden">
          <PaymentPane />
        </TabsContent>
        <TabsContent value="refunds" className="flex min-h-0 flex-1 overflow-auto p-6 lg:p-8">
          <RefundsList />
        </TabsContent>
        <TabsContent value="bankTransfers" className="flex min-h-0 flex-1 overflow-auto p-6 lg:p-8">
          <BankTransfersList />
        </TabsContent>
      </Tabs>
      {offlineOpen ? <OfflineSalesDialog open onOpenChange={setOfflineOpen} /> : null}
    </PageContainer>
  );
}

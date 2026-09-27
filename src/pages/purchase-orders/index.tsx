import { useTranslation } from 'react-i18next';
import { PurchaseOrderListPanel } from '@widgets/PurchaseOrderListPanel';
import { PageContainer } from '@shared/ui';

export default function PurchaseOrdersPage() {
  const { t } = useTranslation('pages');
  return (
    <PageContainer title={t('purchaseOrders.title')}>
      <PurchaseOrderListPanel />
    </PageContainer>
  );
}

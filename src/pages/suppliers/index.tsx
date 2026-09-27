/* eslint-disable import/order, @typescript-eslint/no-confusing-void-expression */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReceiveShipmentForm } from '@features/receive-shipment';
import { SupplierListPanel } from '@widgets/SupplierListPanel';
import { PageContainer, POSButton } from '@shared/ui';
export default function SuppliersPage() {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);
  return (
    <PageContainer
      title={t('suppliers.title')}
      actions={
        <POSButton type="button" onClick={() => setOpen(true)}>
          {t('suppliers.receive')}
        </POSButton>
      }
    >
      <SupplierListPanel />
      <ReceiveShipmentForm open={open} onOpenChange={setOpen} />
    </PageContainer>
  );
}

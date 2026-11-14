import { useTranslation } from 'react-i18next';
import { EditHistoryTable } from '@widgets/EditHistoryTable';
import { PageContainer } from '@shared/ui';

export default function EditHistoryPage() {
  const { t } = useTranslation('pages');
  return (
    <PageContainer title={t('editHistory.title')}>
      <EditHistoryTable />
    </PageContainer>
  );
}

import { useTranslation } from 'react-i18next';
import { RBACDashboard } from '@widgets/RBACDashboard';
import { PageContainer } from '@shared/ui';

export default function RbacPage() {
  const { t } = useTranslation('pages');
  return (
    <PageContainer title={t('rbac.title')}>
      <RBACDashboard />
    </PageContainer>
  );
}

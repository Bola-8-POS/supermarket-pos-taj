import { useTranslation } from 'react-i18next';
import { CajaDashboard } from '@widgets/CajaDashboard';
import { StaffDashboard } from '@widgets/StaffDashboard/StaffDashboard';
import { PageContainer } from '@shared/ui';

export default function StaffPage() {
  const { t } = useTranslation('pages');
  return (
    <PageContainer title={t('staff.title')}>
      <CajaDashboard />
      <StaffDashboard />
    </PageContainer>
  );
}

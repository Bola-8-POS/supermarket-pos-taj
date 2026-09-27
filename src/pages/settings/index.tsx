import { useTranslation } from 'react-i18next';
import { SettingsTabsPanel } from '@widgets/SettingsTabsPanel';
import { PageContainer } from '@shared/ui';

export default function SettingsPage() {
  const { t } = useTranslation('pages');
  return (
    <PageContainer title={t('settings.title')}>
      <SettingsTabsPanel />
    </PageContainer>
  );
}

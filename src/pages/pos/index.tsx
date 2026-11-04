import { useTranslation } from 'react-i18next';
import { CheckoutPanel } from '@widgets/CheckoutPanel/ui/CheckoutPanel';

export default function PosPage() {
  const { t } = useTranslation('pages');
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <h2 className="sr-only">{t('pos.title')}</h2>
      <CheckoutPanel />
    </div>
  );
}

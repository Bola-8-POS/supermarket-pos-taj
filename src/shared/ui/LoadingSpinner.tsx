import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/utils';

interface LoadingSpinnerProps {
  size?: number;
  className?: string;
}

export function LoadingSpinner({ size = 24, className }: LoadingSpinnerProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn('flex items-center justify-center p-4', className)}
      data-testid="loading-spinner"
      role="status"
      aria-live="polite"
      aria-label={t('loading.simple')}
    >
      <Loader2 className="animate-spin text-brand" size={size} aria-hidden="true" />
      <span className="sr-only">{t('loading.tabDetails')}</span>
    </div>
  );
}

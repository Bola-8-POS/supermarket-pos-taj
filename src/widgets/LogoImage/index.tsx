import type { ReactNode } from 'react';
import { useReceiptSettings } from '@entities/settings';
import { cn } from '@shared/lib/utils';

type Props = {
  className?: string;
  alt?: string;
  fallback?: ReactNode;
};

export function LogoImage({ className, alt = 'Logo', fallback = null }: Props) {
  const { data } = useReceiptSettings();
  const logoDataUrl = data?.logoDataUrl ?? null;

  if (!logoDataUrl) return <>{fallback}</>;

  return (
    <img
      data-testid="app-logo"
      src={logoDataUrl}
      alt={alt}
      className={cn('max-h-full max-w-full object-contain', className)}
    />
  );
}

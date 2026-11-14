/**
 * VersionConflictToast — wrapper component that emits the appropriate
 * version-conflict toast on mount. Used in Storybook stories to visualise the
 * two conflict variants. Production code should call `handleVersionError`
 * from `@shared/lib/version-error` directly inside mutation `onError` handlers.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';

export type VersionConflictVariant = 'stale' | 'not-found';

const COPY: Record<VersionConflictVariant, string> = {
  stale: 'Updated by another terminal — please retry',
  'not-found': 'Record was deleted by another terminal.',
};

export interface VersionConflictToastProps {
  variant: VersionConflictVariant;
}

export const VersionConflictToast = ({ variant }: VersionConflictToastProps) => {
  useEffect(() => {
    toast.error(COPY[variant]);
  }, [variant]);
  return null;
};

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { useFeature } from '@shared/lib/license/features';
import { FeatureLockedPage } from '@shared/ui/FeatureLockedPage';

type EditHistoryRouteProps = {
  children: ReactNode;
};

export function EditHistoryRoute({ children }: EditHistoryRouteProps) {
  const { can } = usePermissions();
  const { enabled } = useFeature('edit_history');
  if (!can('view_audit_log')) {
    toast.error('This page is restricted to managers and admins.');
    return <Navigate to="/home" replace />;
  }
  if (!enabled) return <FeatureLockedPage feature="edit_history" />;
  return <>{children}</>;
}

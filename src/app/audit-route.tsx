import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { useFeature } from '@shared/lib/license/features';
import { FeatureLockedPage } from '@shared/ui/FeatureLockedPage';

type AuditRouteProps = {
  children: ReactNode;
};

export function AuditRoute({ children }: AuditRouteProps) {
  const { can } = usePermissions();
  const { enabled } = useFeature('audit_log');
  if (!can('view_audit_log')) {
    toast.error('This page is restricted to managers and admins.');
    return <Navigate to="/home" replace />;
  }
  if (!enabled) return <FeatureLockedPage feature="audit_log" />;
  return <>{children}</>;
}

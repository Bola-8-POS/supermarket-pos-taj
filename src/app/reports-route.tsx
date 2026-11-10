import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@entities/staff/model/usePermissions';

type ReportsRouteProps = {
  children: ReactNode;
};

export function ReportsRoute({ children }: ReportsRouteProps) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  if (!can('view_reports')) {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

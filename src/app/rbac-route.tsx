import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@entities/staff/model/usePermissions';

type RbacRouteProps = {
  children: ReactNode;
};

export function RbacRoute({ children }: RbacRouteProps) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  if (!can('manage_staff')) {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

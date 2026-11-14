import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@entities/staff/model/usePermissions';

type SuppliersRouteProps = {
  children: ReactNode;
};

export function SuppliersRoute({ children }: SuppliersRouteProps) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  if (!can('manage_products')) {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

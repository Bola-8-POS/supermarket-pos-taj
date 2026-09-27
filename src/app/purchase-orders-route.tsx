import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@entities/staff/model/usePermissions';

type PurchaseOrdersRouteProps = {
  children: ReactNode;
};

export function PurchaseOrdersRoute({ children }: PurchaseOrdersRouteProps) {
  const { can } = usePermissions();
  if (!can('manage_products')) {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@entities/staff/model/usePermissions';

type InventoryRouteProps = {
  children: ReactNode;
};

export function InventoryRoute({ children }: InventoryRouteProps) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  if (!can('adjust_inventory')) {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

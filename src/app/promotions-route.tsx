import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePermissions } from '@entities/staff/model/usePermissions';

type PromotionsRouteProps = {
  children: ReactNode;
};

export function PromotionsRoute({ children }: PromotionsRouteProps) {
  const { can } = usePermissions();
  if (!can('manage_promotions')) {
    toast.error('This page is restricted to admins.');
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

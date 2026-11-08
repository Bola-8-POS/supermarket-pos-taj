import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePermissions } from '@entities/staff/model/usePermissions';

export function StoreServerRoute({ children }: { children: ReactNode }) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  if (!can('manage_settings')) {
    toast.error('This page is restricted to admins.');
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

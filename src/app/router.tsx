import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@widgets/AppShell';
import { HelpSheet } from '@widgets/HelpSheet';
import { AgentPanel } from '@features/agent-chat';
import { useStaffStore } from '@entities/staff/model/store';
import { LoadingSpinner } from '@shared/ui/LoadingSpinner';
import { ProtectedRoute } from './ProtectedRoute';
import { AuditRoute } from './audit-route';
import { EditHistoryRoute } from './edit-history-route';
import { PromotionsRoute } from './promotions-route';
import { PurchaseOrdersRoute } from './purchase-orders-route';
import { RbacRoute } from './rbac-route';
import { ReportsRoute } from './reports-route';

const LoginPage = lazy(() => import('../pages/login'));
const HomePage = lazy(() => import('../pages/home'));
const InventoryPage = lazy(() => import('../pages/inventory'));
const SuppliersPage = lazy(() => import('../pages/suppliers'));
const StaffPage = lazy(() => import('../pages/staff'));
const ReportsPage = lazy(() => import('../pages/reports'));
const SettingsPage = lazy(() => import('../pages/settings'));
const PaymentsPage = lazy(() => import('../pages/payments'));
const PosPage = lazy(() => import('../pages/pos'));
const RbacPage = lazy(() => import('../pages/rbac'));
const AuditPage = lazy(() => import('../pages/audit'));
const EditHistoryPage = lazy(() => import('../pages/edit-history'));
const PurchaseOrdersPage = lazy(() => import('../pages/purchase-orders'));
const PromotionsPage = lazy(() => import('../pages/promotions'));

function LoadingFallback() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <LoadingSpinner size={28} />
    </div>
  );
}

/** Auth gate + persistent chrome for every signed-in route. */
function ShellLayout() {
  return (
    <ProtectedRoute>
      <AppShell />
    </ProtectedRoute>
  );
}

export function Router() {
  // AI assistant is a staff tool — never render it before someone is logged
  // in (its suggestion chips surface staff-only actions on the unauthenticated
  // PIN picker otherwise).
  const isStaffAuthenticated = useStaffStore(s => s.isAuthenticated);

  return (
    <BrowserRouter>
      <HelpSheet />
      {isStaffAuthenticated && <AgentPanel />}
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route element={<ShellLayout />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/suppliers" element={<SuppliersPage />} />
            <Route
              path="/reports"
              element={
                <ReportsRoute>
                  <ReportsPage />
                </ReportsRoute>
              }
            />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/pos" element={<PosPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route
              path="/rbac"
              element={
                <RbacRoute>
                  <RbacPage />
                </RbacRoute>
              }
            />
            <Route
              path="/audit"
              element={
                <AuditRoute>
                  <AuditPage />
                </AuditRoute>
              }
            />
            <Route
              path="/edit-history"
              element={
                <EditHistoryRoute>
                  <EditHistoryPage />
                </EditHistoryRoute>
              }
            />
            <Route
              path="/purchase-orders"
              element={
                <PurchaseOrdersRoute>
                  <PurchaseOrdersPage />
                </PurchaseOrdersRoute>
              }
            />
            <Route
              path="/promotions"
              element={
                <PromotionsRoute>
                  <PromotionsPage />
                </PromotionsRoute>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { InventoryPagePanel } from '@widgets/InventoryPagePanel';
import { PhysicalCountForm } from '@features/physical-count';
import {
  LowStockBadge,
  NearExpiryBadge,
  useInventoryAlerts,
  useInventoryRealtimeBridge,
  useNearExpiryAlerts,
} from '@entities/inventory';
import { useStaffStore } from '@entities/staff/model/store';
import { canAccess } from '@shared/lib/rbac';
import { PageContainer, POSButton } from '@shared/ui';

/**
 * Fires a Sonner toast whenever a new low-stock alert arrives.
 * Compares the current alert product IDs against the previous render
 * to detect genuinely new entries (avoids toasting on mount).
 */
function useLowStockToast() {
  const { t } = useTranslation('pages');
  const { data: alerts } = useInventoryAlerts();
  const prevIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!alerts) return;

    const currentIds = new Set(alerts.map(a => a.productId));

    if (prevIdsRef.current === null) {
      // First load — record baseline, don't toast
      prevIdsRef.current = currentIds;
      return;
    }

    // Find alerts that weren't in the previous set
    for (const alert of alerts) {
      if (!prevIdsRef.current.has(alert.productId)) {
        toast.warning(
          t('inventory.lowStockToast', {
            productName: alert.productName,
            currentStock: alert.currentStock,
            threshold: alert.threshold,
          })
        );
      }
    }

    prevIdsRef.current = currentIds;
  }, [alerts, t]);
}

function useNearExpiryToast() {
  const { t } = useTranslation('pages');
  const { data: alerts } = useNearExpiryAlerts();
  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!alerts) return;
    const currentIds = new Set(alerts.map(alert => alert.productId));
    if (prevIdsRef.current === null) {
      prevIdsRef.current = currentIds;
      return;
    }
    for (const alert of alerts)
      if (!prevIdsRef.current.has(alert.productId))
        toast.warning(
          t('inventory.nearExpiryToast', {
            productName: alert.productName,
            days: alert.daysUntilExpiry,
          })
        );
    prevIdsRef.current = currentIds;
  }, [alerts, t]);
}

function InventoryPageInner() {
  const { t } = useTranslation('pages');
  // Mount the Realtime bridge once for this page
  useInventoryRealtimeBridge();
  // Fire toasts on new low-stock alerts
  useLowStockToast();
  useNearExpiryToast();

  const role = useStaffStore(s => s.currentStaff?.role);
  const canPhysicalCount = canAccess(role, 'adjust_inventory');
  const [physicalCountOpen, setPhysicalCountOpen] = useState(false);

  return (
    <PageContainer
      title={t('inventory.title')}
      actions={
        <>
          {/* Low-stock counts are inventory-management data (per CLAUDE.md,
                  /inventory's write actions are manager+) — gated behind the
                  same adjust_inventory check as Physical Count so a cashier's
                  read-only visit to /inventory doesn't surface it. Near-expiry
                  stays ungated: CLAUDE.md documents it as visible everywhere,
                  including checkout. */}
          {canPhysicalCount && <LowStockBadge />}
          <NearExpiryBadge />
          {canPhysicalCount && (
            <POSButton
              variant="outline"
              touchSize="default"
              data-testid="physical-count-btn"
              onClick={() => {
                setPhysicalCountOpen(true);
              }}
            >
              {t('inventory.physicalCount')}
            </POSButton>
          )}
        </>
      }
    >
      <InventoryPagePanel />
      {canPhysicalCount && (
        <PhysicalCountForm open={physicalCountOpen} onOpenChange={setPhysicalCountOpen} />
      )}
    </PageContainer>
  );
}

export default function InventoryPage() {
  return <InventoryPageInner />;
}

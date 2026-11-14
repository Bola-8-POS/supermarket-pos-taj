import { useTranslation } from 'react-i18next';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { useResolveOfflineSale } from '../model/useResolveOfflineSale';
import { OfflineSalesPanel } from './OfflineSalesPanel';

export interface OfflineSalesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Review dialog for offline sales (two-mode Plan 02b, Task 7). Open to every role: a cashier who
 * owns a refused sale cannot sign out, so a manager is never the signed-in user, and the manager
 * actions therefore ask for the manager's PIN instead of being hidden (see `OfflineSalesPanel`).
 *
 * The resolution model mounts several queries, so it lives in the body, which exists only while
 * the dialog is open.
 */
export function OfflineSalesDialog({ open, onOpenChange }: OfflineSalesDialogProps) {
  const { t } = useTranslation('featOrders');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="offline-sales-dialog"
        className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{t('reviewOfflineSales.dialog.title')}</DialogTitle>
          <DialogDescription>{t('reviewOfflineSales.dialog.description')}</DialogDescription>
        </DialogHeader>
        <OfflineSalesBody
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function OfflineSalesBody({ onClose }: { onClose: () => void }) {
  const records = useOfflineSaleStore(s => s.records);
  const signedInStaffId = useStaffStore(s => s.currentStaff?.id);
  const { can } = usePermissions();
  const resolver = useResolveOfflineSale();
  return (
    <OfflineSalesPanel
      records={records}
      signedInStaffId={signedInStaffId}
      resolver={resolver}
      canAdjustStock={can('adjust_inventory')}
      onClose={onClose}
    />
  );
}

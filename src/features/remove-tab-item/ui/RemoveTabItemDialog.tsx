import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { OrderItem } from '@shared/lib/domain';
import { ConfirmDialog, Input, MoneyDisplay } from '@shared/ui';

import { useRemoveTabItem } from '../useRemoveTabItem';

export interface RemoveTabItemDialogProps {
  /** Whether the confirm dialog is open (shown after PIN verified externally). */
  open: boolean;
  /** The order item to remove, or null when dialog is closed. */
  item: OrderItem | null;
  tabId: string;
  orderId: string;
  /** Called when the dialog should close (on cancel or after success). */
  onClose: () => void;
}

/**
 * RemoveTabItemDialog — Step 2 of the remove-item flow.
 *
 * Renders a destructive ConfirmDialog for removing a single order item from a tab.
 * Manager PIN gate (Step 1) is intentionally excluded: cross-feature imports violate
 * FSD. The parent widget must compose ManagerPinDialog and only open this dialog
 * after PIN is verified (see TableStatusPanel for the full two-step orchestration).
 */
export function RemoveTabItemDialog({
  open,
  item,
  tabId,
  orderId,
  onClose,
}: RemoveTabItemDialogProps) {
  const { t } = useTranslation('featOrders');
  const { removeTabItem, isPending } = useRemoveTabItem();
  const [reason, setReason] = useState('');

  if (!item) return null;

  const lineTotal = (item.unitPrice + item.modifierPriceDelta) * item.quantity;
  const productName = item.product?.name ?? t('removeTabItem.unknownItem');
  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length > 0;

  const handleClose = () => {
    setReason('');
    onClose();
  };

  const handleConfirm = async () => {
    const result = await removeTabItem({
      tabId,
      orderId,
      itemId: item.id,
      productId: item.productId,
      quantity: item.quantity,
      reason: trimmedReason,
    });

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    toast.success(t('removeTabItem.removedFromOrder', { name: productName }));
    handleClose();
  };

  return (
    <ConfirmDialog
      open={open}
      title={t('removeTabItem.title')}
      description={t('removeTabItem.description')}
      confirmLabel={t('removeTabItem.confirmLabel')}
      variant="destructive"
      isLoading={isPending}
      confirmDisabled={!canConfirm}
      onConfirm={handleConfirm}
      onCancel={handleClose}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-muted/40 p-3.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-muted-foreground">
              {item.quantity}x {productName}
            </span>
            <MoneyDisplay amount={lineTotal} size="sm" />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="remove-tab-item-reason" className="text-sm font-medium">
            {t('removeTabItem.reasonLabel')}
          </label>
          <Input
            id="remove-tab-item-reason"
            value={reason}
            onChange={event => {
              setReason(event.target.value);
            }}
            placeholder={t('removeTabItem.reasonPlaceholder')}
            required
          />
        </div>
      </div>
    </ConfirmDialog>
  );
}

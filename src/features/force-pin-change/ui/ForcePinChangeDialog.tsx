import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { Staff } from '@shared/lib/domain';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';

import { useForcePinChange } from '../model/useForcePinChange';

export interface ForcePinChangeDialogProps {
  staff: Staff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Manager/admin confirmation dialog that flags a staff member's account so
 * they must set a new PIN before their next login (force_pin_change RPC).
 */
export function ForcePinChangeDialog({ staff, open, onOpenChange }: ForcePinChangeDialogProps) {
  const { t } = useTranslation('featMgmt');
  const mutation = useForcePinChange();

  async function handleConfirm(): Promise<void> {
    if (!staff) return;

    const result = await mutation.mutateAsync({ staffId: staff.id });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    toast.success(t('forcePinChange.successToast', { name: staff.name }));
    onOpenChange(false);
  }

  return (
    <ConfirmDialog
      open={open && staff !== null}
      title={t('forcePinChange.dialogTitle', { name: staff?.name ?? '' })}
      description={t('forcePinChange.dialogDescription', {
        name: staff?.name ?? t('forcePinChange.fallbackStaffName'),
      })}
      confirmLabel={t('forcePinChange.confirmLabel')}
      cancelLabel={t('forcePinChange.cancelLabel')}
      onConfirm={handleConfirm}
      onCancel={() => {
        onOpenChange(false);
      }}
      isLoading={mutation.isPending}
    />
  );
}

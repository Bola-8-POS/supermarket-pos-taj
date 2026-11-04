import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationUpdateStaffRole } from '@entities/staff/model/queries';
import type { Staff } from '@shared/lib/domain';
import { UserRoleSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { POSButton } from '@shared/ui/POSButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Label } from '@shared/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui/select';

export type EditRoleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: Staff[];
  currentStaffId: string | null;
  preSelectedStaffId: string | undefined;
};

const ROLE_OPTIONS = UserRoleSchema.options;

export function EditRoleDialog({
  open,
  onOpenChange,
  staff,
  currentStaffId,
  preSelectedStaffId,
}: EditRoleDialogProps) {
  const { t } = useTranslation('featMgmt');
  const editableStaff = staff.filter(s => s.id !== currentStaffId);

  const [selectedStaffId, setSelectedStaffId] = useState<string>(preSelectedStaffId ?? '');
  const [selectedRole, setSelectedRole] = useState<string>('');

  const mutation = useMutationUpdateStaffRole();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelectedStaffId('');
      setSelectedRole('');
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!selectedStaffId || !selectedRole) return;

    const parsed = UserRoleSchema.safeParse(selectedRole);
    if (!parsed.success) {
      toast.error(t('editStaffRole.invalidRole'));
      return;
    }

    const result = await mutation.mutateAsync({
      staffId: selectedStaffId,
      role: parsed.data,
    });

    if (!result.ok) {
      logger.error('edit-staff-role.submit.failed', { message: result.error.message });
      toast.error(t('editStaffRole.updateFailed'), { description: result.error.message });
      return;
    }

    const member = editableStaff.find(s => s.id === selectedStaffId);
    toast.success(t('editStaffRole.updateSuccess'), {
      description: t('editStaffRole.updateSuccessDescription', {
        name: member?.name ?? t('editStaffRole.fallbackStaffName'),
        role: parsed.data,
      }),
    });
    handleOpenChange(false);
  }

  const canSubmit = Boolean(selectedStaffId) && Boolean(selectedRole) && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('editStaffRole.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('editStaffRole.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-role-staff">{t('editStaffRole.staffMemberLabel')}</Label>
            <Select
              value={selectedStaffId}
              onValueChange={setSelectedStaffId}
              disabled={editableStaff.length === 0}
            >
              <SelectTrigger id="edit-role-staff">
                <SelectValue placeholder={t('editStaffRole.selectStaffPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {editableStaff.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-role-role">{t('editStaffRole.newRoleLabel')}</Label>
            <Select value={selectedRole} onValueChange={setSelectedRole}>
              <SelectTrigger id="edit-role-role">
                <SelectValue placeholder={t('editStaffRole.selectRolePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map(role => (
                    <SelectItem key={role} value={role} className="capitalize">
                      {role}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {editableStaff.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('editStaffRole.noOtherStaff')}</p>
          )}
        </div>

        <DialogFooter>
          <POSButton
            type="button"
            variant="outline"
            touchSize="default"
            onClick={() => {
              handleOpenChange(false);
            }}
            disabled={mutation.isPending}
          >
            {t('editStaffRole.cancel')}
          </POSButton>
          <LockedFeature feature="staff_management">
            <POSButton
              type="button"
              touchSize="default"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={!canSubmit}
            >
              {mutation.isPending ? t('editStaffRole.saving') : t('editStaffRole.save')}
            </POSButton>
          </LockedFeature>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

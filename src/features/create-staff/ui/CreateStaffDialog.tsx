import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PinSchema, UserRoleSchema, LocaleSchema, type Locale, type UserRole } from '@shared/lib/domain';
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
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui/select';
import { useCreateStaff } from '../model/useCreateStaff';

export type CreateStaffDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ROLE_OPTIONS = UserRoleSchema.options;
const LOCALE_OPTIONS = LocaleSchema.options;

export function CreateStaffDialog({ open, onOpenChange }: CreateStaffDialogProps) {
  const { t } = useTranslation('staff');

  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [role, setRole] = useState<UserRole | ''>('');
  const [locale, setLocale] = useState<Locale>('es-MX');

  const mutation = useCreateStaff();

  function resetForm() {
    setName('');
    setPin('');
    setConfirmPin('');
    setRole('');
    setLocale('es-MX');
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm();
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!role) return;

    if (pin !== confirmPin || !PinSchema.safeParse(pin).success) {
      toast.error(t('addStaff.pinMismatch'));
      return;
    }

    const result = await mutation.mutateAsync({ name, pin, role, locale });

    if (!result.ok) {
      logger.error('create-staff.submit.failed', { message: result.error.message });
      toast.error(t('addStaff.genericFailure'));
      return;
    }

    toast.success(t('addStaff.successToast', { name }));
    handleOpenChange(false);
  }

  const canSubmit =
    name.trim().length > 0 &&
    PinSchema.safeParse(pin).success &&
    PinSchema.safeParse(confirmPin).success &&
    Boolean(role) &&
    !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addStaff.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('addStaff.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-staff-name" className="font-normal">
              {t('addStaff.nameLabel')}
            </Label>
            <Input
              id="create-staff-name"
              value={name}
              onChange={e => {
                setName(e.target.value);
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="create-staff-pin" className="font-normal">
              {t('addStaff.pinLabel')}
            </Label>
            <Input
              id="create-staff-pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={e => {
                setPin(e.target.value);
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="create-staff-confirm-pin" className="font-normal">
              {t('addStaff.confirmPinLabel')}
            </Label>
            <Input
              id="create-staff-confirm-pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={confirmPin}
              onChange={e => {
                setConfirmPin(e.target.value);
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="create-staff-role" className="font-normal">
              {t('addStaff.roleLabel')}
            </Label>
            <Select
              value={role}
              onValueChange={value => {
                const parsed = UserRoleSchema.safeParse(value);
                if (!parsed.success) return;
                setRole(parsed.data);
              }}
            >
              <SelectTrigger id="create-staff-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map(option => (
                    <SelectItem key={option} value={option} className="capitalize">
                      {option}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="create-staff-locale" className="font-normal">
              {t('addStaff.localeLabel')}
            </Label>
            <Select
              value={locale}
              onValueChange={value => {
                const parsed = LocaleSchema.safeParse(value);
                if (!parsed.success) return;
                setLocale(parsed.data);
              }}
            >
              <SelectTrigger id="create-staff-locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LOCALE_OPTIONS.map(option => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
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
            {t('common:actions.cancel')}
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
              {mutation.isPending ? t('addStaff.creating') : t('addStaff.create')}
            </POSButton>
          </LockedFeature>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

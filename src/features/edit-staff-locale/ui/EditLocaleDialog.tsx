import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationUpdateStaffLocale } from '@entities/staff/model/queries';
import type { Staff } from '@shared/lib/domain';
import { LocaleSchema, type Locale } from '@shared/lib/domain';
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

export type EditLocaleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: Staff | null;
};

const LOCALE_OPTIONS = LocaleSchema.options;

// Row-action-triggered dialog for a single target staff member (admin
// override, D-03). Deliberately never switches the acting admin's own UI
// locale here — this write only affects the target's stored profiles.locale;
// their own session picks it up on next login/hydrate (UI-SPEC.md Interaction
// Contract step 4).
export function EditLocaleDialog({ open, onOpenChange, staff }: EditLocaleDialogProps) {
  const { t } = useTranslation('staff');
  const [selectedLocale, setSelectedLocale] = useState<Locale>(staff?.locale ?? 'es-MX');

  const mutation = useMutationUpdateStaffLocale();

  function handleOpenChange(next: boolean) {
    if (next && staff) {
      setSelectedLocale(staff.locale);
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (!staff) return;

    const parsed = LocaleSchema.safeParse(selectedLocale);
    if (!parsed.success) {
      toast.error(t('locale.updateError', { name: staff.name }));
      return;
    }

    const result = await mutation.mutateAsync({ staffId: staff.id, locale: parsed.data });

    if (!result.ok) {
      logger.error('edit-staff-locale.submit.failed', { message: result.error.message });
      toast.error(t('locale.updateError', { name: staff.name }));
      return;
    }

    toast.success(t('locale.updateSuccess', { name: staff.name, locale: parsed.data }));
    handleOpenChange(false);
  }

  const canSubmit = Boolean(staff) && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('locale.editTrigger')}</DialogTitle>
          <DialogDescription>{staff?.name ?? ''}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-locale-locale">{t('table.locale')}</Label>
            <Select
              value={selectedLocale}
              onValueChange={value => {
                const parsed = LocaleSchema.safeParse(value);
                if (!parsed.success) return;
                setSelectedLocale(parsed.data);
              }}
            >
              <SelectTrigger id="edit-locale-locale">
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
              {mutation.isPending ? t('common:actions.saving') : t('common:actions.save')}
            </POSButton>
          </LockedFeature>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

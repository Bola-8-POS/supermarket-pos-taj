import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { useStaffStore } from '@entities/staff/model/store';
import { formatMoney } from '@shared/lib/format';
import i18n from '@shared/lib/i18n';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { useRegisterCajaEntry } from '../model/useRegisterCajaEntry';

// Built fresh (not a module-level const) so a locale switch is reflected in the
// next validation instead of baking in whichever language was active at first
// import (Rule 1 fix, same pattern as open-tab's OpenTabDialog).
function buildFormSchema() {
  return z.object({
    type: z.enum(['expense', 'income']),
    amount: z.coerce.number().positive(i18n.t('featOrders:registerCajaEntry.amountPositive')),
    concept: z
      .string()
      .min(1, i18n.t('featOrders:registerCajaEntry.conceptRequired'))
      .max(200, i18n.t('featOrders:registerCajaEntry.conceptMaxLength')),
  });
}

interface RegisterCajaEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RegisterCajaEntryDialog({ open, onOpenChange }: RegisterCajaEntryDialogProps) {
  const { t } = useTranslation('featOrders');
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [concept, setConcept] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const currentStaff = useStaffStore(s => s.currentStaff);
  const { registerEntry, isPending } = useRegisterCajaEntry();

  function resetForm() {
    setType('expense');
    setAmount('');
    setConcept('');
    setErrors({});
  }

  function handleClose() {
    resetForm();
    onOpenChange(false);
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});

    const validation = buildFormSchema().safeParse({ type, amount, concept });

    if (!validation.success) {
      const fieldErrors: Record<string, string> = {};
      validation.error.issues.forEach(issue => {
        const key = issue.path[0];
        if (key !== undefined) {
          fieldErrors[String(key)] = issue.message;
        }
      });
      setErrors(fieldErrors);
      return;
    }

    if (!currentStaff) {
      toast.error(t('registerCajaEntry.noActiveStaff'));
      return;
    }

    const result = await registerEntry({
      type: validation.data.type,
      amount: validation.data.amount,
      concept: validation.data.concept,
      staffId: currentStaff.id,
    });

    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }

    toast.success(
      t(
        type === 'expense'
          ? 'registerCajaEntry.expenseRecorded'
          : 'registerCajaEntry.incomeRecorded',
        {
          amount: formatMoney(validation.data.amount),
        }
      )
    );
    resetForm();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) handleClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('registerCajaEntry.title')}</DialogTitle>
        </DialogHeader>

        <form
          data-testid="entry-form"
          onSubmit={e => {
            void handleSubmit(e);
          }}
        >
          <div className="space-y-4 py-2">
            {/* Type toggle */}
            <div className="space-y-1">
              <Label>{t('registerCajaEntry.typeLabel')}</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={type === 'expense' ? 'destructive' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setType('expense');
                  }}
                >
                  {t('registerCajaEntry.expense')}
                </Button>
                <Button
                  type="button"
                  variant={type === 'income' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setType('income');
                  }}
                >
                  {t('registerCajaEntry.income')}
                </Button>
              </div>
              {errors.type && <p className="text-sm text-destructive">{errors.type}</p>}
            </div>

            {/* Amount */}
            <div className="space-y-1">
              <Label htmlFor="entry-amount">
                {t('registerCajaEntry.amountLabel')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="entry-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={e => {
                  setAmount(e.target.value);
                }}
                placeholder="0.00"
                disabled={isPending}
              />
              {errors.amount && <p className="text-sm text-destructive">{errors.amount}</p>}
            </div>

            {/* Concept */}
            <div className="space-y-1">
              <Label htmlFor="entry-concept">
                {t('registerCajaEntry.conceptLabel')} <span className="text-destructive">*</span>
              </Label>
              <textarea
                id="entry-concept"
                value={concept}
                onChange={e => {
                  setConcept(e.target.value);
                }}
                maxLength={200}
                rows={3}
                placeholder={t('registerCajaEntry.conceptPlaceholder')}
                disabled={isPending}
                className="w-full rounded-lg border border-input bg-card px-3 shadow-xs dark:bg-input/20 py-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
              {errors.concept && <p className="text-sm text-destructive">{errors.concept}</p>}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={isPending}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? t('common:actions.saving') : t('registerCajaEntry.saveEntry')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

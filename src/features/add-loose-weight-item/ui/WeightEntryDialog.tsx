import { Delete } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromotionMatch } from '@entities/promotion';
import { useCartStore, calcWeightedLineTotal } from '@entities/tab/model/cartStore';
import type { Product } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { useLockStateStore } from '@shared/lib/lock-state-store';
import { POSButton } from '@shared/ui/POSButton';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';

export interface WeightEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product;
  mode: 'add' | 'edit';
  initialWeightGrams?: number;
  tempId?: string;
  /** Overrides the default cartStore.addWeightedItem/updateWeightedItem call.
   *  Used by the peek window (D-04: no direct cart-store access there). */
  onConfirm?: (weightGrams: number) => void;
  /**
   * Resolves the best promotion for the weight being entered. The server prices a loose-weight
   * line first and discounts the LINE, so this must evaluate on the line (the caller passes
   * `resolveProductPromotion(..., weightGrams)`); the match's `discountedUnitPrice` is then the
   * line total, shown in the helper text and handed to the cart store. The dialog stays a
   * presentation component: the caller resolves, the dialog does not.
   */
  resolveMatch?: (weightGrams: number) => PromotionMatch | null | undefined;
}

const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'];

function gramsFromKg(value: string): number {
  const kilograms = Number(value);
  return Number.isFinite(kilograms) ? Math.round(kilograms * 1000) : 0;
}

export function WeightEntryDialog({
  open,
  onOpenChange,
  product,
  mode,
  initialWeightGrams,
  tempId,
  onConfirm,
  resolveMatch,
}: WeightEntryDialogProps) {
  const { t } = useTranslation('featOrders');
  const addWeightedItem = useCartStore(state => state.addWeightedItem);
  const updateWeightedItem = useCartStore(state => state.updateWeightedItem);
  const [value, setValue] = useState(() =>
    initialWeightGrams == null ? '' : String(initialWeightGrams / 1000)
  );
  const weightGrams = gramsFromKg(value);
  const isValid = weightGrams > 0 && weightGrams <= 50_000;
  const locked = useLockStateStore(s => s.locked);
  const match = isValid ? resolveMatch?.(weightGrams) : undefined;
  const lineTotal =
    match?.discountedUnitPrice ?? calcWeightedLineTotal(product.basePrice, weightGrams);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!open || locked) return;
      if (/^[0-9]$/.test(event.key)) {
        setValue(current => current + event.key);
      }
      if (event.key === '.' && !value.includes('.')) {
        setValue(current => current + '.');
      }
      if (event.key === 'Backspace') {
        setValue(current => current.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, locked, value]);

  const append = (key: string) => {
    if (key !== '.' || !value.includes('.')) {
      setValue(current => current + key);
    }
  };

  const confirm = () => {
    if (!isValid) return;
    if (onConfirm) onConfirm(weightGrams);
    else if (mode === 'edit' && tempId) {
      if (match)
        updateWeightedItem(tempId, weightGrams, match.discountedUnitPrice, match.promotionId);
      else updateWeightedItem(tempId, weightGrams);
    } else addWeightedItem(product, weightGrams, match?.discountedUnitPrice, match?.promotionId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weightEntry.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-muted/50 p-4 text-center">
            <p className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {t('weightEntry.fieldLabel')}
            </p>
            <p aria-live="polite" className="text-numeric text-4xl font-semibold">
              {value || '0'} {t('weightEntry.kilograms')}
            </p>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            {t('weightEntry.helperText', {
              total: formatMoney(lineTotal),
            })}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {keypad.map(key => (
              <Button
                key={key}
                type="button"
                variant="outline"
                className="h-14 rounded-xl text-xl font-medium tabular-nums"
                onClick={() => {
                  append(key);
                }}
              >
                {key}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="h-14 rounded-xl text-muted-foreground"
              onClick={() => {
                setValue(current => current.slice(0, -1));
              }}
              aria-label={t('common:actions.back')}
            >
              <Delete className="size-5" />
            </Button>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <POSButton
            type="button"
            variant="outline"
            touchSize="large"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common:actions.cancel')}
          </POSButton>
          <POSButton type="button" touchSize="xl" disabled={!isValid} onClick={confirm}>
            {mode === 'edit' ? t('weightEntry.edit') : t('weightEntry.confirm')}
          </POSButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

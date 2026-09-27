/**
 * RefundSheet - right-side Sheet for processing post-payment refunds.
 *
 * State machine:
 *   CLOSED -> OPEN (SELECTING) -> CONFIGURING -> PIN_MODAL -> SUBMITTING -> CLOSED
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ManagerPinDialog } from '@features/manager-pin-gate';
import { useOrderItemsByPayment } from '@entities/payment';
import { useRefundsByPayment } from '@entities/refund';
import type { RefundReason } from '@entities/refund';
import { formatMoney } from '@shared/lib/format';
import { MoneyDisplay, POSButton, QuantityControl } from '@shared/ui';
import { Checkbox } from '@shared/ui/checkbox';
import { Label } from '@shared/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@shared/ui/sheet';

import { useProcessRefund } from '../model/useProcessRefund';

// ============================================================================
// TYPES
// ============================================================================

interface RefundItemState {
  orderItemId: string;
  productName: string;
  unitPrice: number;
  originalQty: number;
  alreadyRefundedQty: number;
  selected: boolean;
  refundQty: number;
  restock: boolean;
}

interface ItemOverride {
  selected: boolean;
  refundQty: number;
  restock: boolean;
}

export interface RefundSheetProps {
  open: boolean;
  paymentId: string | null;
  onOpenChange: (open: boolean) => void;
}

// ============================================================================
// REASON LABELS
// ============================================================================

const REFUND_REASONS: RefundReason[] = [
  'wrong_order',
  'quality_issue',
  'customer_complaint',
  'billing_error',
  'other',
];

// ============================================================================
// COMPONENT
// ============================================================================

export function RefundSheet({ open, paymentId, onOpenChange }: RefundSheetProps) {
  const { t } = useTranslation('featOrders');
  const { data: orderItemsRaw, isLoading: itemsLoading } = useOrderItemsByPayment(paymentId);
  const { data: existingRefunds } = useRefundsByPayment(paymentId);
  const mutation = useProcessRefund();

  const [overrides, setOverrides] = useState(new Map<string, ItemOverride>());
  const [reason, setReason] = useState<RefundReason | ''>('');
  const [pinOpen, setPinOpen] = useState(false);

  const refundedQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const refund of existingRefunds ?? []) {
      for (const item of refund.items) {
        map.set(item.orderItemId, (map.get(item.orderItemId) ?? 0) + item.qty);
      }
    }
    return map;
  }, [existingRefunds]);

  const items = useMemo((): RefundItemState[] => {
    return (orderItemsRaw ?? []).map(raw => {
      const alreadyRefundedQty = refundedQtyMap.get(raw.id) ?? 0;
      const maxRefundableQty = raw.qty - alreadyRefundedQty;
      const override = overrides.get(raw.id);
      return {
        orderItemId: raw.id,
        productName: raw.products.name,
        unitPrice: raw.unit_price,
        originalQty: raw.qty,
        alreadyRefundedQty,
        selected: override?.selected ?? false,
        refundQty: override?.refundQty ?? (maxRefundableQty > 0 ? maxRefundableQty : 0),
        restock: override?.restock ?? false,
      };
    });
  }, [orderItemsRaw, refundedQtyMap, overrides]);

  const selectedItems = items.filter(i => i.selected);
  const refundTotal = selectedItems.reduce((sum, i) => sum + i.unitPrice * i.refundQty, 0);
  const isValid = selectedItems.length >= 1 && reason !== '' && refundTotal > 0;

  function toggleItem(orderItemId: string) {
    setOverrides(prev => {
      const next = new Map(prev);
      const raw = (orderItemsRaw ?? []).find(r => r.id === orderItemId);
      if (!raw) return prev;
      const alreadyRefundedQty = refundedQtyMap.get(orderItemId) ?? 0;
      const maxQty = raw.qty - alreadyRefundedQty;
      const cur = next.get(orderItemId);
      const wasSelected = cur?.selected ?? false;
      next.set(orderItemId, {
        selected: !wasSelected,
        refundQty: cur?.refundQty ?? (maxQty > 0 ? maxQty : 0),
        restock: cur?.restock ?? false,
      });
      return next;
    });
  }

  function updateQty(orderItemId: string, qty: number) {
    setOverrides(prev => {
      const next = new Map(prev);
      const cur = next.get(orderItemId);
      next.set(orderItemId, {
        selected: cur?.selected ?? false,
        refundQty: qty,
        restock: cur?.restock ?? false,
      });
      return next;
    });
  }

  function updateRestock(orderItemId: string, restock: boolean) {
    setOverrides(prev => {
      const next = new Map(prev);
      const cur = next.get(orderItemId);
      if (!cur) return prev;
      next.set(orderItemId, { ...cur, restock });
      return next;
    });
  }

  async function handleSubmitRefund(approvalId: string, approverId: string) {
    if (!paymentId) return;
    const result = await mutation.mutateAsync({
      originalPaymentId: paymentId,
      items: selectedItems.map(item => ({
        order_item_id: item.orderItemId,
        qty: item.refundQty,
        amount: item.unitPrice * item.refundQty,
        restock: item.restock,
      })),
      reason: reason as RefundReason,
      approvalId,
      approverId,
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(
      t('processRefund.refundProcessed', {
        amount: formatMoney(Math.round(refundTotal * 100) / 100),
      }),
      // Longer than Sonner's 4000ms default: a financial confirmation toast fading
      // before it's read is a real UX gap on its own, and it also has to outlast the
      // tutorial-video harness's slowMo-paced narrate() assertion window (gap G-34-1).
      { duration: 8000 }
    );
    onOpenChange(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setReason('');
      setPinOpen(false);
      setOverrides(new Map());
    }
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
          <SheetHeader>
            <SheetTitle>{t('processRefund.title')}</SheetTitle>
            <SheetDescription>{t('processRefund.description')}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 flex-1 space-y-2 px-1">
            {itemsLoading && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('processRefund.loadingItems')}
              </p>
            )}
            {!itemsLoading && items.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('processRefund.noRefundableItems')}
              </p>
            )}
            {items.map(item => {
              const maxQty = item.originalQty - item.alreadyRefundedQty;
              const fullyRefunded = maxQty <= 0;
              return (
                <div
                  key={item.orderItemId}
                  className={
                    'rounded-lg border border-border bg-card p-3 space-y-2 shadow-xs transition-opacity' +
                    (fullyRefunded ? ' opacity-50' : '')
                  }
                  title={fullyRefunded ? t('processRefund.fullyRefunded') : undefined}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={'refund-item-' + item.orderItemId}
                      checked={item.selected}
                      disabled={fullyRefunded}
                      onCheckedChange={() => {
                        if (!fullyRefunded) toggleItem(item.orderItemId);
                      }}
                      aria-label={t('processRefund.selectForRefund', { name: item.productName })}
                    />
                    <label
                      htmlFor={'refund-item-' + item.orderItemId}
                      className="flex-1 text-sm font-medium cursor-pointer"
                    >
                      {item.productName}
                    </label>
                    <MoneyDisplay amount={item.unitPrice} size="sm" />
                  </div>
                  {item.selected && (
                    <div className="flex items-center gap-4 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {t('processRefund.qty')}
                        </span>
                        <QuantityControl
                          value={item.refundQty}
                          min={1}
                          max={maxQty}
                          onChange={qty => {
                            updateQty(item.orderItemId, qty);
                          }}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={'restock-' + item.orderItemId}
                          checked={item.restock}
                          onCheckedChange={checked => {
                            updateRestock(item.orderItemId, checked === true);
                          }}
                          aria-label={t('processRefund.restockAria', { name: item.productName })}
                        />
                        <Label htmlFor={'restock-' + item.orderItemId} className="text-xs">
                          {t('processRefund.restock')}
                        </Label>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sticky bottom-0 space-y-3 border-t border-border bg-popover px-6 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="refund-reason" className="text-sm font-medium">
                {t('processRefund.reason')} <span className="text-destructive">*</span>
              </Label>
              <Select
                value={reason}
                onValueChange={val => {
                  setReason(val as RefundReason);
                }}
              >
                <SelectTrigger id="refund-reason" className="w-full">
                  <SelectValue placeholder={t('processRefund.selectReasonPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {REFUND_REASONS.map(r => (
                    <SelectItem key={r} value={r}>
                      {t(`processRefund.reasonLabels.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold">{t('processRefund.refundTotal')}</span>
              <MoneyDisplay amount={refundTotal} size="lg" negative={true} />
            </div>
          </div>

          <SheetFooter className="px-6 pb-6 flex gap-3">
            <POSButton
              variant="outline"
              touchSize="large"
              className="flex-1"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('processRefund.closeRefund')}
            </POSButton>
            <POSButton
              touchSize="xl"
              focusEmphasis="high"
              className="flex-1"
              disabled={!isValid || mutation.isPending}
              onClick={() => {
                setPinOpen(true);
              }}
            >
              {t('processRefund.requestApproval')}
            </POSButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="process_refund"
        onSuccess={(staff, approvalId) => {
          setPinOpen(false);
          void handleSubmitRefund(approvalId, staff.id);
        }}
      />
    </>
  );
}

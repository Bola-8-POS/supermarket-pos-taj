/**
 * EditPaidTabDialog - right-side Sheet for correcting an already-paid tab.
 *
 * Mirrors RefundSheet's shell (Sheet -> Save -> ManagerPinDialog -> submit),
 * swapping refund-specific fields for a free-text reason, per-row qty/price/
 * notes editors, add/remove item affordances, and a tab-level notes field.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ManagerPinDialog } from '@features/manager-pin-gate';
import { useProducts } from '@entities/product';
import { tabKeys, useTab } from '@entities/tab';
import { formatMoney } from '@shared/lib/format';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';
import { handleVersionError } from '@shared/lib/version-error';
import {
  Badge,
  ConfirmDialog,
  Input,
  Label,
  MoneyDisplay,
  POSButton,
  QuantityControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@shared/ui';

import type { EditPaidTabPatch } from '../model/useEditPaidTab';
import { useEditPaidTab } from '../model/useEditPaidTab';

// ============================================================================
// TYPES
// ============================================================================

interface ItemOverride {
  quantity: number;
  unitPrice: number;
  notes: string;
}

interface AddedRow {
  key: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface EditPaidTabDialogProps {
  open: boolean;
  tabId: string | null;
  onOpenChange: (open: boolean) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function EditPaidTabDialog({ open, tabId, onOpenChange }: EditPaidTabDialogProps) {
  const { t } = useTranslation('featOrders');
  const queryClient = useQueryClient();
  const { data: tab, isLoading: tabLoading } = useTab(tabId ?? '');
  const { data: products } = useProducts();
  const mutation = useEditPaidTab();

  const [overrides, setOverrides] = useState(new Map<string, ItemOverride>());
  const [removedIds, setRemovedIds] = useState(new Set<string>());
  const [addedRows, setAddedRows] = useState<AddedRow[]>([]);
  const [tabNotes, setTabNotes] = useState('');
  const [reason, setReason] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !tab) return;
    /* eslint-disable react-hooks/set-state-in-effect -- initializing local edit
       state from the loaded tab when the sheet opens, same pattern as
       GeneralSettingsTab's data->form sync */
    setTabNotes(tab.notes ?? '');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, tab]);

  const existingRows = useMemo(() => {
    return (tab?.items ?? [])
      .filter(item => !removedIds.has(item.id))
      .map(item => {
        const override = overrides.get(item.id);
        const originalNotes = item.notes ?? '';
        const quantity = override?.quantity ?? item.quantity;
        const unitPrice = override?.unitPrice ?? item.unitPrice;
        const notes = override?.notes ?? originalNotes;
        return {
          id: item.id,
          productName: item.product?.name ?? t('editPaidTab.unknownItem'),
          quantity,
          unitPrice,
          notes,
          edited:
            quantity !== item.quantity || unitPrice !== item.unitPrice || notes !== originalNotes,
        };
      });
  }, [tab?.items, overrides, removedIds, t]);

  const originalTotal = useMemo(
    () => (tab?.items ?? []).reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
    [tab?.items]
  );
  const newTotal = useMemo(() => {
    const existingTotal = existingRows.reduce((sum, r) => sum + r.quantity * r.unitPrice, 0);
    const addedTotal = addedRows.reduce((sum, r) => sum + r.quantity * r.unitPrice, 0);
    return existingTotal + addedTotal;
  }, [existingRows, addedRows]);
  const totalDelta = Math.round((newTotal - originalTotal) * 100) / 100;

  const isValid = reason.trim() !== '' && !mutation.isPending;

  function updateOverride(itemId: string, patch: Partial<ItemOverride>) {
    setOverrides(prev => {
      const next = new Map(prev);
      const original = (tab?.items ?? []).find(i => i.id === itemId);
      const cur = next.get(itemId) ?? {
        quantity: original?.quantity ?? 1,
        unitPrice: original?.unitPrice ?? 0,
        notes: original?.notes ?? '',
      };
      next.set(itemId, { ...cur, ...patch });
      return next;
    });
  }

  function updateAddedRow(key: string, patch: Partial<AddedRow>) {
    setAddedRows(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)));
  }

  function handleAddItem() {
    const first = products?.[0];
    if (!first) return;
    setAddedRows(prev => [
      ...prev,
      { key: crypto.randomUUID(), productId: first.id, quantity: 1, unitPrice: first.basePrice },
    ]);
  }

  async function handleSubmit(approvalId: string, approverId: string) {
    if (!tab) return;

    const patches: EditPaidTabPatch[] = [];
    /* eslint-disable i18next/no-literal-string -- 'op' is an RPC patch discriminator value, not UI copy */
    for (const item of tab.items) {
      if (removedIds.has(item.id)) {
        patches.push({ op: 'delete', id: item.id });
        continue;
      }
      const o = overrides.get(item.id);
      if (o) {
        patches.push({
          op: 'update',
          id: item.id,
          quantity: o.quantity,
          unit_price: o.unitPrice,
          notes: o.notes,
        });
      }
    }
    for (const row of addedRows) {
      patches.push({
        op: 'add',
        product_id: row.productId,
        quantity: row.quantity,
        unit_price: row.unitPrice,
      });
    }
    /* eslint-enable i18next/no-literal-string */

    const result = await mutation.mutateAsync({
      tabId: tab.id,
      expectedVersion: tab.version ?? 0,
      orderItemPatches: patches,
      notes: tabNotes,
      reason,
      approvalId,
      approverId,
    });

    if (!result.ok) {
      const isVersionConflict =
        result.error.code === 'STALE_VERSION' || result.error.code === 'NOT_FOUND_VERSIONED';
      if (
        isVersionConflict &&
        handleVersionError(result.error, {
          queryClient,
          queryKey: tabKeys.detail(tab.id),
          entity: 'tabs',
          entityId: tab.id,
          expectedVersion: tab.version ?? 0,
          supabase,
          terminalId: getTerminalId(),
        })
      ) {
        onOpenChange(false);
        return;
      }
      toast.error(
        result.error.message !== '' ? result.error.message : t('editPaidTab.genericError')
      );
      return;
    }
    toast.success(t('editPaidTab.editSaved'));
    onOpenChange(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setOverrides(new Map());
      setRemovedIds(new Set());
      setAddedRows([]);
      setTabNotes('');
      setReason('');
      setPinOpen(false);
      setRemoveTargetId(null);
    }
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
          <SheetHeader>
            <SheetTitle>{t('editPaidTab.title')}</SheetTitle>
            <SheetDescription>{t('editPaidTab.description')}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 flex-1 space-y-2 px-1">
            {tabLoading && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('editPaidTab.loadingItems')}
              </p>
            )}
            {!tabLoading && existingRows.length === 0 && addedRows.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('editPaidTab.noItems')}
              </p>
            )}
            {existingRows.map(row => (
              <div key={row.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium">{row.productName}</span>
                  {row.edited && <Badge variant="outline">{t('editPaidTab.editedBadge')}</Badge>}
                  <POSButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      setRemoveTargetId(row.id);
                    }}
                  >
                    {t('editPaidTab.removeItem')}
                  </POSButton>
                </div>
                <div className="flex items-end gap-4">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('editPaidTab.qty')}</span>
                    <QuantityControl
                      value={row.quantity}
                      min={1}
                      max={99}
                      onChange={qty => {
                        updateOverride(row.id, { quantity: qty });
                      }}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`edit-price-${row.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      {t('editPaidTab.unitPriceLabel')}
                    </Label>
                    <Input
                      id={`edit-price-${row.id}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.unitPrice}
                      onChange={e => {
                        updateOverride(row.id, { unitPrice: Number(e.target.value) || 0 });
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`edit-notes-${row.id}`} className="text-xs text-muted-foreground">
                    {t('editPaidTab.itemNotesLabel')}
                  </Label>
                  <Input
                    id={`edit-notes-${row.id}`}
                    value={row.notes}
                    onChange={e => {
                      updateOverride(row.id, { notes: e.target.value });
                    }}
                  />
                </div>
              </div>
            ))}
            {addedRows.map(row => (
              <div key={row.key} className="rounded-lg border border-dashed p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={row.productId}
                    onValueChange={val => {
                      const product = products?.find(p => p.id === val);
                      updateAddedRow(row.key, {
                        productId: val,
                        unitPrice: product?.basePrice ?? row.unitPrice,
                      });
                    }}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(products ?? []).map(p => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <POSButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => {
                      setAddedRows(prev => prev.filter(r => r.key !== row.key));
                    }}
                  >
                    {t('editPaidTab.removeItem')}
                  </POSButton>
                </div>
                <div className="flex items-end gap-4">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t('editPaidTab.qty')}</span>
                    <QuantityControl
                      value={row.quantity}
                      min={1}
                      max={99}
                      onChange={qty => {
                        updateAddedRow(row.key, { quantity: qty });
                      }}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`add-price-${row.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      {t('editPaidTab.unitPriceLabel')}
                    </Label>
                    <Input
                      id={`add-price-${row.key}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.unitPrice}
                      onChange={e => {
                        updateAddedRow(row.key, { unitPrice: Number(e.target.value) || 0 });
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            <POSButton
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddItem}
              disabled={!products || products.length === 0}
            >
              {t('editPaidTab.addItem')}
            </POSButton>
          </div>

          <div className="sticky bottom-0 space-y-3 border-t border-border bg-popover px-6 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-paid-tab-notes" className="text-sm font-medium">
                {t('editPaidTab.ticketNotesLabel')}
              </Label>
              <Input
                id="edit-paid-tab-notes"
                value={tabNotes}
                onChange={e => {
                  setTabNotes(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-paid-tab-reason" className="text-sm font-medium">
                {t('editPaidTab.reason')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-paid-tab-reason"
                placeholder={t('editPaidTab.reasonPlaceholder')}
                value={reason}
                onChange={e => {
                  setReason(e.target.value);
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold">{t('editPaidTab.newTotal')}</span>
              <MoneyDisplay amount={newTotal} size="lg" negative={totalDelta < 0} />
            </div>
            {totalDelta !== 0 && (
              <p className="text-xs text-muted-foreground">
                {t('editPaidTab.totalDeltaHint', {
                  amount: formatMoney(totalDelta, { showSign: true }),
                })}
              </p>
            )}
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
              {t('editPaidTab.cancel')}
            </POSButton>
            <POSButton
              touchSize="xl"
              focusEmphasis="high"
              className="flex-1"
              disabled={!isValid}
              onClick={() => {
                setPinOpen(true);
              }}
            >
              {t('editPaidTab.saveCorrection')}
            </POSButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={removeTargetId !== null}
        title={t('editPaidTab.removeItemConfirmTitle')}
        description={t('editPaidTab.removeItemConfirmDescription')}
        confirmLabel={t('editPaidTab.removeItemConfirmLabel')}
        variant="destructive"
        onConfirm={() => {
          if (removeTargetId) {
            setRemovedIds(prev => new Set(prev).add(removeTargetId));
          }
          setRemoveTargetId(null);
        }}
        onCancel={() => {
          setRemoveTargetId(null);
        }}
      />

      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="edit_paid_tab"
        onSuccess={(staff, approvalId) => {
          setPinOpen(false);
          void handleSubmit(approvalId, staff.id);
        }}
      />
    </>
  );
}

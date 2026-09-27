/**
 * EditReopenedItemsPanel - right-side Sheet for adding/removing items on a
 * reopened (status='open') sale.
 *
 * Mirrors EditPaidTabDialog's shell/addedRows pattern for the add side
 * (wired to useAddItemToTab / create_order_with_items). The remove side
 * reproduces the deleted TableStatusPanel's two-step PIN-then-confirm
 * orchestration, composing RemoveTabItemDialog/useRemoveTabItem unmodified
 * (D-05) behind its own ManagerPinDialog.
 *
 * D-04: ONE ManagerPinDialog confirms the whole pending add when Save is
 * clicked — not one PIN prompt per row.
 * D-03/D-05: every item removal gets its own independent PIN prompt
 * (one-item-per-prompt), not shared with the add-side's single PIN.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useAddItemToTab } from '@features/add-item-to-tab';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { RemoveTabItemDialog } from '@features/remove-tab-item/ui/RemoveTabItemDialog';
import { useProducts } from '@entities/product';
import { useStaffStore } from '@entities/staff/model/store';
import { tabKeys, useTab } from '@entities/tab';
import type { OrderItem } from '@shared/lib/domain';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';
import { handleVersionError } from '@shared/lib/version-error';
import {
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

interface AddedRow {
  key: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface EditReopenedItemsPanelProps {
  open: boolean;
  tabId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function EditReopenedItemsPanel({ open, tabId, onOpenChange }: EditReopenedItemsPanelProps) {
  const { t } = useTranslation('featOrders');
  const queryClient = useQueryClient();
  const { data: tab, isLoading: tabLoading } = useTab(tabId ?? '');
  const { data: products } = useProducts();
  const currentStaff = useStaffStore(s => s.currentStaff);
  const { addItems, isPending } = useAddItemToTab();

  const [addedRows, setAddedRows] = useState<AddedRow[]>([]);
  const [addPinOpen, setAddPinOpen] = useState(false);
  const [showPinForRemoval, setShowPinForRemoval] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [selectedItemForRemoval, setSelectedItemForRemoval] = useState<OrderItem | null>(null);

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

  async function handleSubmit() {
    if (!tab) return;

    const result = await addItems({
      tabId: tab.id,
      staffId: currentStaff?.id ?? '',
      items: addedRows.map(row => ({
        productId: row.productId,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
      })),
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
        result.error.message !== '' ? result.error.message : t('editReopenedItems.addItemError')
      );
      return;
    }

    // Success keeps the Sheet open (unlike EditPaidTabDialog) — this panel
    // hosts multiple independent PIN-gated actions (add now, remove in
    // Plan 09-03); a successful add should let the manager keep editing.
    toast.success(t('editReopenedItems.itemAdded'));
    setAddedRows([]);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setAddedRows([]);
      setAddPinOpen(false);
      setShowPinForRemoval(false);
      setShowRemoveConfirm(false);
      setSelectedItemForRemoval(null);
    }
    onOpenChange(nextOpen);
  }

  const existingItems = tab?.items ?? [];

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
          <SheetHeader>
            <SheetTitle>{t('editReopenedItems.title')}</SheetTitle>
            <SheetDescription>{t('editReopenedItems.description')}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 flex-1 space-y-2 px-1">
            {tabLoading && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('editPaidTab.loadingItems')}
              </p>
            )}
            {!tabLoading && existingItems.length === 0 && addedRows.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('editPaidTab.noItems')}</p>
            )}
            {existingItems.map(item => (
              <div key={item.id} className="flex items-center gap-2 rounded-lg border p-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {item.quantity}x {item.product?.name ?? t('editPaidTab.unknownItem')}
                </span>
                <MoneyDisplay amount={item.quantity * item.unitPrice} size="sm" />
                <POSButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    setSelectedItemForRemoval(item);
                    setShowPinForRemoval(true);
                  }}
                >
                  {t('editReopenedItems.removeItem')}
                </POSButton>
              </div>
            ))}
            {addedRows.map(row => (
              <div key={row.key} className="space-y-2 rounded-lg border border-dashed p-3">
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
                    <SelectTrigger className="min-w-0 flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(products ?? []).map(p => (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="min-w-0 truncate">{p.name}</span>
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
                    <span className="text-xs text-muted-foreground">{t('editReopenedItems.qty')}</span>
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
                      htmlFor={`edit-reopened-price-${row.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      {t('editReopenedItems.unitPriceLabel')}
                    </Label>
                    <Input
                      id={`edit-reopened-price-${row.key}`}
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
              {t('editReopenedItems.addItem')}
            </POSButton>
          </div>

          <SheetFooter className="flex gap-3 px-6 pb-6">
            <POSButton
              variant="outline"
              touchSize="large"
              className="flex-1"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              {t('editReopenedItems.cancel')}
            </POSButton>
            <POSButton
              touchSize="xl"
              focusEmphasis="high"
              className="flex-1"
              disabled={addedRows.length === 0 || isPending}
              onClick={() => {
                setAddPinOpen(true);
              }}
            >
              {t('editReopenedItems.saveChanges')}
            </POSButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ManagerPinDialog
        open={addPinOpen}
        onOpenChange={setAddPinOpen}
        requiredAction="reopen_tab"
        onSuccess={() => {
          setAddPinOpen(false);
          void handleSubmit();
        }}
      />

      <ManagerPinDialog
        open={showPinForRemoval}
        onOpenChange={open => {
          if (!open) {
            setShowPinForRemoval(false);
            setSelectedItemForRemoval(null);
          }
        }}
        requiredAction="reopen_tab"
        onSuccess={() => {
          setShowPinForRemoval(false);
          setShowRemoveConfirm(true);
        }}
      />

      <RemoveTabItemDialog
        open={showRemoveConfirm}
        item={selectedItemForRemoval}
        tabId={tab?.id ?? ''}
        orderId={selectedItemForRemoval?.orderId ?? ''}
        onClose={() => {
          setShowRemoveConfirm(false);
          setSelectedItemForRemoval(null);
        }}
      />
    </>
  );
}

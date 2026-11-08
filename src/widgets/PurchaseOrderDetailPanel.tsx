import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PurchaseOrderForm } from '@features/create-purchase-order';
import { ReceiveShipmentForm } from '@features/receive-shipment';
import { useMutationUpdatePurchaseOrder, usePurchaseOrder } from '@entities/purchase-order';
import { err, unknownError } from '@shared/lib/result';
import { TableRowSkeleton } from '@shared/ui/LoadingSkeletons';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { POSButton } from '@shared/ui/POSButton';
import { StatusBadge } from '@shared/ui/StatusBadge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@shared/ui/table';

export function PurchaseOrderDetailPanel({
  purchaseOrderId,
  onClose,
}: {
  purchaseOrderId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('wAdmin');
  const { data: po, isLoading } = usePurchaseOrder(purchaseOrderId);
  const update = useMutationUpdatePurchaseOrder();
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);

  if (isLoading || !po) {
    return (
      <div className="space-y-4">
        <DialogHeader>
          <DialogTitle className="sr-only">{t('purchaseOrderDetailPanel.title')}</DialogTitle>
        </DialogHeader>
        <TableRowSkeleton columns={4} />
        <TableRowSkeleton columns={4} />
      </div>
    );
  }

  const items = po.items ?? [];
  const total = items.reduce((sum, item) => sum + item.quantity * item.costPrice, 0);
  const formatDate = (value: Date | string) =>
    new Date(value).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
  const isDraft = po.status === 'draft';

  return (
    <>
      <DialogHeader>
        <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {t('purchaseOrderDetailPanel.title')}
        </span>
        <DialogTitle className="text-xl">{po.supplier?.name}</DialogTitle>
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <StatusBadge status={po.status === 'received' ? 'po_received' : 'po_draft'} />
            <span>
              {t('purchaseOrderDetailPanel.createdOn', { date: formatDate(po.createdAt) })}
            </span>
            {po.receivedAt ? (
              <span>
                {t('purchaseOrderDetailPanel.receivedOn', { date: formatDate(po.receivedAt) })}
              </span>
            ) : null}
            <span>{t('purchaseOrderDetailPanel.itemCount', { count: items.length })}</span>
          </div>
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[50dvh] overflow-y-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('purchaseOrderDetailPanel.columnProduct')}</TableHead>
              <TableHead className="w-28 text-right">
                {t('purchaseOrderDetailPanel.columnQuantity')}
              </TableHead>
              <TableHead className="w-32 text-right">
                {t('purchaseOrderDetailPanel.columnCost')}
              </TableHead>
              <TableHead className="w-32 text-right">
                {t('purchaseOrderDetailPanel.columnSubtotal')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.product?.name}</TableCell>
                <TableCell className="text-right text-numeric">{item.quantity}</TableCell>
                <TableCell className="text-right">
                  <MoneyDisplay amount={item.costPrice} />
                </TableCell>
                <TableCell className="text-right">
                  <MoneyDisplay amount={item.quantity * item.costPrice} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="font-medium">
                {t('purchaseOrderDetailPanel.total')}
              </TableCell>
              <TableCell className="text-right">
                <MoneyDisplay amount={total} className="font-semibold" />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <DialogFooter showCloseButton={false} className="sm:justify-between">
        <POSButton type="button" variant="ghost" onClick={onClose}>
          {t('common:actions.close')}
        </POSButton>
        {isDraft && (
          <div className="flex gap-2">
            <POSButton
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('purchaseOrderDetailPanel.edit')}
            </POSButton>
            <POSButton
              type="button"
              variant="brand"
              focusEmphasis="high"
              onClick={() => {
                setReceiving(true);
              }}
            >
              {t('purchaseOrderDetailPanel.receive')}
            </POSButton>
          </div>
        )}
      </DialogFooter>

      <ReceiveShipmentForm
        open={receiving}
        onOpenChange={setReceiving}
        initialPurchaseOrder={{
          id: po.id,
          supplierId: po.supplierId,
          items: items.map(item => ({
            productId: item.productId,
            productName: item.product?.name ?? '',
            quantity: item.quantity,
            costPrice: item.costPrice,
          })),
        }}
      />
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('purchaseOrderDetailPanel.edit')}</DialogTitle>
            <DialogDescription>{t('purchaseOrderDetailPanel.editDescription')}</DialogDescription>
          </DialogHeader>
          {editing && (
            <PurchaseOrderForm
              initialPurchaseOrder={po}
              submitting={update.isPending}
              onCancel={() => {
                setEditing(false);
              }}
              onSubmitCreate={() => Promise.resolve(err(unknownError()))}
              onSubmitUpdate={value =>
                void update.mutateAsync(value, {
                  onSuccess: r => {
                    if (r.ok) {
                      toast.success(t('purchaseOrderForm.created', { ns: 'featMgmt' }));
                      setEditing(false);
                    } else toast.error(r.error.message);
                  },
                })
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

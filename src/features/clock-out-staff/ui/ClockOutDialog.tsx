import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationClockOut, useShiftClosePreview } from '@entities/staff/model/queries';
import type { Shift, Staff } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { ConfirmDialog, MoneyDisplay, MoneyInput } from '@shared/ui';

export type ClockOutDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: Staff | null;
  shift: Shift | null;
};

function formatDurationMs(ms: number): string {
  const totalM = Math.floor(ms / 60000);
  const h = Math.floor(totalM / 60);
  const m = totalM % 60;
  if (h <= 0) return i18n.t('featMgmt:clockOutStaff.durationMinutes', { minutes: m });
  return i18n.t('featMgmt:clockOutStaff.durationHoursMinutes', { hours: h, minutes: m });
}

export function ClockOutDialog({ open, onOpenChange, staff, shift }: ClockOutDialogProps) {
  const { t } = useTranslation('featMgmt');
  const [closingCash, setClosingCash] = useState(0);
  const [durationMs, setDurationMs] = useState(() =>
    shift ? Date.now() - shift.clockIn.getTime() : 0
  );
  const clockOut = useMutationClockOut();
  const previewQuery = useShiftClosePreview(shift?.id ?? null, staff?.id ?? null);

  useEffect(() => {
    if (!open || !shift) return;
    const id = window.setInterval(() => {
      setDurationMs(Date.now() - shift.clockIn.getTime());
    }, 30_000);
    return () => {
      window.clearInterval(id);
    };
  }, [open, shift]);

  const summary = previewQuery.data;
  const effectiveOpen = open && staff != null && shift != null;

  const handleConfirm = async (): Promise<void> => {
    if (!staff || !shift) return;
    const result = await clockOut.mutateAsync({
      shiftId: shift.id,
      staffId: staff.id,
      closingCash,
    });
    if (!result.ok) {
      logger.error('clock_out_dialog.failed', { message: result.error.message });
      toast.error(result.error.message);
      return;
    }
    toast.success(t('clockOutStaff.clockedOut', { name: staff.name }));
    onOpenChange(false);
    setClosingCash(0);
  };

  return (
    <ConfirmDialog
      open={effectiveOpen}
      title={t('clockOutStaff.endShiftTitle')}
      description={staff && shift ? t('clockOutStaff.closeShiftFor', { name: staff.name }) : ''}
      confirmLabel={t('clockOutStaff.clockOutButton')}
      variant="destructive"
      onConfirm={() => {
        void handleConfirm();
      }}
      onCancel={() => {
        onOpenChange(false);
      }}
      isLoading={clockOut.isPending}
      confirmDisabled={clockOut.isPending}
    >
      {staff && shift ? (
        <div className="space-y-4 py-2 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">{t('clockOutStaff.shiftDuration')}</span>
            <span className="font-medium tabular-nums">{formatDurationMs(durationMs)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">{t('clockOutStaff.clockInLabel')}</span>
            <span className="font-medium tabular-nums">
              {shift.clockIn.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          {previewQuery.isIdleOrLoading && (
            <p className="text-muted-foreground text-xs">{t('clockOutStaff.loadingTotals')}</p>
          )}
          {summary && (
            <>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('clockOutStaff.ordersTaken')}</span>
                <span className="font-medium">{String(summary.orderCount)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('clockOutStaff.salesPayments')}</span>
                <MoneyDisplay amount={summary.totalSales} size="sm" />
              </div>
            </>
          )}
          <MoneyInput
            label={t('clockOutStaff.closingCashLabel')}
            value={closingCash}
            onChange={setClosingCash}
            disabled={clockOut.isPending}
            placeholder="0.00"
          />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

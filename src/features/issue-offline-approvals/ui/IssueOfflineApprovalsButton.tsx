import { ShieldCheck } from 'lucide-react';
import { useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ManagerPinDialog } from '@features/manager-pin-gate';
import { availableOfflineGrants } from '@entities/staff/model/offlineApproval';
import { useOnlineStatus } from '@shared/lib/connectivity';
import type { Staff } from '@shared/lib/domain';
import { Button } from '@shared/ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';

import { GRANTABLE_ACTIONS, useIssueOfflineApprovals, type GrantableAction } from '../model/useIssueOfflineApprovals';

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

/**
 * Opens the offline-approvals panel: per grantable action, how many
 * pre-approvals this terminal holds, and an Issue button that asks for a
 * manager PIN (online only) and then issues `count` grants valid for `hours`.
 */
export function IssueOfflineApprovalsButton() {
  const { t } = useTranslation('featOrders');
  const online = useOnlineStatus();
  const issue = useIssueOfflineApprovals();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(5);
  const [hours, setHours] = useState(4);
  const [pendingAction, setPendingAction] = useState<GrantableAction | null>(null);
  // Grants live in localStorage; re-render after issuing so the counts refresh.
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  async function handleApproved(staff: Staff, approvalId: string, action: GrantableAction): Promise<void> {
    setPendingAction(null);
    const res = await issue.mutateAsync({ approvalId, approverId: staff.id, action, count, validMinutes: hours * 60 });
    if (res.ok) {
      toast.success(t('issueOfflineApprovals.issued', { count: res.data.length }));
    } else {
      toast.error(res.error.message);
    }
    refresh();
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        <ShieldCheck className="size-4" aria-hidden="true" />
        {t('issueOfflineApprovals.open')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('issueOfflineApprovals.title')}</DialogTitle>
            <DialogDescription>{t('issueOfflineApprovals.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="offline-approvals-count">{t('issueOfflineApprovals.count')}</Label>
              <Input
                id="offline-approvals-count"
                type="number"
                min={1}
                max={10}
                value={count}
                onChange={e => {
                  setCount(clamp(e.target.valueAsNumber, 1, 10, count));
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="offline-approvals-hours">{t('issueOfflineApprovals.hours')}</Label>
              <Input
                id="offline-approvals-hours"
                type="number"
                min={1}
                max={4}
                value={hours}
                onChange={e => {
                  setHours(clamp(e.target.valueAsNumber, 1, 4, hours));
                }}
              />
            </div>
          </div>

          <ul className="divide-y rounded-md border">
            {GRANTABLE_ACTIONS.map(action => {
              const label = t(`issueOfflineApprovals.actions.${action}`);
              return (
                <li key={action} aria-label={label} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="font-medium">{label}</span>
                  <span className="ml-auto text-sm text-muted-foreground">
                    {t('issueOfflineApprovals.available', { count: availableOfflineGrants(action).length })}
                  </span>
                  <Button
                    size="sm"
                    disabled={!online || issue.isPending}
                    aria-label={t('issueOfflineApprovals.issueFor', { action: label })}
                    onClick={() => {
                      setPendingAction(action);
                    }}
                  >
                    {t('issueOfflineApprovals.issue')}
                  </Button>
                </li>
              );
            })}
          </ul>

          {!online && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('issueOfflineApprovals.needsConnection')}
            </p>
          )}
        </DialogContent>
      </Dialog>

      <ManagerPinDialog
        open={pendingAction !== null}
        onOpenChange={next => {
          if (!next) setPendingAction(null);
        }}
        requiredAction={pendingAction ?? 'process_refund'}
        onSuccess={(staff, approvalId) => {
          if (pendingAction) void handleApproved(staff, approvalId, pendingAction);
        }}
      />
    </>
  );
}

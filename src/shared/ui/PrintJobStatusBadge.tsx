/**
 * PRINT JOB STATUS BADGE (Phase 19 — Store-Local Durable Printing Service)
 *
 * Single shared component for the phase's 6-way print-job status vocabulary
 * (D-07) — used identically wherever a print job can be triggered
 * (ReprintButton is the first wired caller; PaymentForm/PaymentPane/caja
 * summary/test-print/cash-drawer are future callers per UI-SPEC).
 *
 * Deliberately a sibling of StatusBadge, not a StatusBadge variant: this
 * badge overrides the shadcn Badge default `font-semibold` to `font-medium`
 * to stay inside this phase's 2-weight typography budget (UI-SPEC).
 *
 * `unknown` is the only interactive status: clicking the badge opens a
 * "Did this print?" ConfirmDialog (D-06) — "Yes, it printed" dismisses with
 * no further action; "No, print again" triggers the caller-supplied
 * `onReprint` (a genuinely fresh print call, new idempotency key) and then
 * dismisses. A separate "x" dismisses the badge locally only (D-08) — it
 * never touches the job's status in the broker's ledger.
 */
import { AlertTriangle, Ban, CheckCircle2, Clock, X, XCircle, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PrintJobStatus } from '@shared/lib/domain';
import { cn } from '@shared/lib/utils';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { Badge } from '@shared/ui/badge';

export type PrintJobStatusBadgeProps = {
  status: PrintJobStatus;
  /** Called when the operator answers "No, print again" on an `unknown` job. */
  onReprint: () => void;
  className?: string;
};

type StatusConfig = {
  icon: LucideIcon;
  labelKey: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  /** Color-token override per UI-SPEC (never bg-destructive/pos-danger for 'unknown'). */
  className?: string;
};

const statusConfig: Record<PrintJobStatus, StatusConfig> = {
  accepted: { icon: Clock, labelKey: 'printJobStatus.accepted', variant: 'secondary' },
  submitted_to_os: { icon: Clock, labelKey: 'printJobStatus.submittedToOs', variant: 'secondary' },
  os_reported_printed: {
    icon: CheckCircle2,
    labelKey: 'printJobStatus.completed',
    variant: 'default',
    className: 'bg-success-soft text-success-strong',
  },
  failed: {
    icon: XCircle,
    labelKey: 'printJobStatus.failed',
    variant: 'destructive',
    className: 'bg-destructive-soft text-destructive',
  },
  unknown: {
    icon: AlertTriangle,
    labelKey: 'printJobStatus.unknown',
    variant: 'default',
    className: 'bg-warning-soft text-warning-strong',
  },
  cancelled: { icon: Ban, labelKey: 'printJobStatus.cancelled', variant: 'secondary' },
};

export function PrintJobStatusBadge({ status, onReprint, className }: PrintJobStatusBadgeProps) {
  const { t } = useTranslation('common');
  const [dismissed, setDismissed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (dismissed) return null;

  const config = statusConfig[status];
  const Icon = config.icon;
  const label = t(config.labelKey);

  const badge = (
    <Badge
      role="status"
      aria-label={label}
      variant={config.variant}
      className={cn('font-medium', config.className, className)}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  );

  if (status !== 'unknown') {
    return badge;
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          setConfirmOpen(true);
        }}
        className="inline-flex"
      >
        {badge}
      </button>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
        }}
        aria-label={t('actions.close')}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={t('printJobConfirm.title')}
        description={t('printJobConfirm.description')}
        confirmLabel={t('printJobConfirm.yes')}
        cancelLabel={t('printJobConfirm.no')}
        variant="default"
        onConfirm={() => {
          setConfirmOpen(false);
        }}
        onCancel={() => {
          onReprint();
          setConfirmOpen(false);
        }}
      />
    </span>
  );
}

/**
 * AuditLogDetailSheet — read-only right-side Sheet rendering JsonDiffViewer
 * for a single audit log row. Copies the RefundSheet/SplitTabSheet Sheet
 * shape exactly (14-UI-SPEC.md section D). No footer/mutation — this Sheet
 * is read-only.
 */
import { useTranslation } from 'react-i18next';

import { useAssistantProposalText } from '@entities/assistant';
import type { AuditLog } from '@entities/audit-log';
import { useStaffStore } from '@entities/staff/model/store';
import { JsonDiffViewer } from '@shared/ui/JsonDiffViewer/JsonDiffViewer';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@shared/ui/sheet';

export interface AuditLogDetailSheetProps {
  row: AuditLog | null;
  /** Resolved staff name for `row.actorId`, or null when unknown/system. */
  actorName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isTruncatedPayload(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_truncated' in value &&
    (value as { _truncated?: unknown })._truncated === true
  );
}

export function AuditLogDetailSheet({
  row,
  actorName,
  open,
  onOpenChange,
}: AuditLogDetailSheetProps) {
  const { t } = useTranslation('wAdmin');
  const { t: tc } = useTranslation('common');
  const isAdmin = useStaffStore(s => s.currentStaff?.role === 'admin');
  const isAssistant = row?.action.startsWith('assistant.') === true;
  // D-17: only an admin sees what was typed. Hiding the section is a convenience; the table's RLS is the control.
  const message = useAssistantProposalText(isAssistant && isAdmin && open ? row.entityId : null);
  const isTruncated = row
    ? isTruncatedPayload(row.before) || isTruncatedPayload(row.after)
    : false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
        <SheetHeader>
          <SheetTitle>
            {row && isAssistant ? tc(`auditActions.${row.action}`, { defaultValue: row.action }) : (row?.action ?? '')}
          </SheetTitle>
          <SheetDescription>
            {row
              ? `${row.entityType} · ${row.createdAt.toLocaleString()} · ${actorName ?? t('auditLogDetailSheet.system')}`
              : ''}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1 space-y-2 px-1">
          {message.isError && (
            <p data-testid="assistant-message-unavailable" className="text-sm text-muted-foreground">
              {t('auditLogDetailSheet.messageUnavailable')}
            </p>
          )}
          {message.data != null && (
            <section aria-label={t('auditLogDetailSheet.message')}>
              <h3 className="text-sm font-medium">{t('auditLogDetailSheet.message')}</h3>
              <p data-testid="assistant-raw-message" className="mt-1 whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-sm">
                {message.data}
              </p>
            </section>
          )}
          {row && (
            <JsonDiffViewer before={row.before} after={row.after} truncated={isTruncated} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

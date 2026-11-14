/**
 * PrintJobDetailSheet — read-only right-side Sheet rendering a print job's
 * ordered event timeline. Mirrors AuditLogDetailSheet's Sheet/SheetContent/
 * SheetHeader wiring exactly, but replaces JsonDiffViewer with a vertical
 * timeline list (the broker's events table is naturally an ordered list,
 * not a before/after diff — 19-07-PLAN.md Task 1, must_haves).
 *
 * Never references a `payload` field — this phase's API response doesn't
 * include one (Plan 19-06 didn't add it), so there is nothing to guard
 * against being purged by Plan 19-05's retention pass.
 */
import { useTranslation } from 'react-i18next';

import type { PrintJobDetail } from '@entities/print-job';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@shared/ui/sheet';

export interface PrintJobDetailSheetProps {
  row: PrintJobDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PrintJobDetailSheet({ row, open, onOpenChange }: PrintJobDetailSheetProps) {
  const { t } = useTranslation('wAdmin');

  const SEPARATOR = ' · '; // eslint-disable-line i18next/no-literal-string -- visual separator glyph, not translatable copy
  const description = row
    ? [
        row.origin,
        row.printerName,
        row.createdAt.toLocaleString(),
        row.winSpoolJobId !== null
          ? t('printJobDetailSheet.winSpoolJobId', { id: row.winSpoolJobId })
          : null,
      ]
        .filter(Boolean)
        .join(SEPARATOR)
    : '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
        <SheetHeader>
          <SheetTitle>{row?.jobId ?? ''}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1 px-1">
          {row && row.events.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('printJobDetailSheet.noEvents')}</p>
          )}
          {row && row.events.length > 0 && (
            <ol className="space-y-3">
              {row.events.map((event, index) => (
                // eslint-disable-next-line react/no-array-index-key -- events have no stable id; order + ts is the identity
                <li
                  key={`${String(event.ts.getTime())}-${String(index)}`}
                  className="border-l-2 border-muted pl-3"
                >
                  <p className="font-medium">{event.category}</p>
                  <p className="text-xs text-muted-foreground">{event.ts.toLocaleString()}</p>
                  {event.detail && (
                    <p className="text-sm text-muted-foreground">{event.detail}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

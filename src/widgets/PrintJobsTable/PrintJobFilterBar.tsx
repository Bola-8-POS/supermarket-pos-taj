/**
 * PrintJobFilterBar — origin, printer name, status, and date-range controls
 * + "Apply filters" button, rendered via DataTable's `toolbar` prop on the
 * Print Jobs tab. Mirrors AuditLogFilterBar's exact staged/onStagedChange/
 * onApply prop contract (19-07-PLAN.md Task 1).
 */
import { useTranslation } from 'react-i18next';

import type { PrintJobFilters } from '@entities/print-job';
import { PrintJobStatusSchema } from '@shared/lib/domain';
import { FormField } from '@shared/ui/FormField';
import { POSButton } from '@shared/ui/POSButton';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

/** Sentinel value for the "All ..." option (Radix Select disallows value=""). */
const ALL_VALUE = '__all__';

/** The five known print-job origin values this phase's callers use. */
const ORIGINS = ['receipt', 'reprint', 'caja_summary', 'test_print', 'cash_drawer'] as const;

export interface PrintJobFilterBarProps {
  staged: PrintJobFilters;
  onStagedChange: (next: PrintJobFilters) => void;
  onApply: (filters: PrintJobFilters) => void;
}

function toDateInputValue(date: Date | undefined): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${d}`;
}

const DATE_INPUT_CLASS =
  'h-11 rounded-lg border border-input bg-card px-2 shadow-xs dark:bg-input/20 py-1 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none';

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const entries = Object.entries(obj).filter(([k]) => k !== key);
  return Object.fromEntries(entries) as Omit<T, K>;
}

export function PrintJobFilterBar({ staged, onStagedChange, onApply }: PrintJobFilterBarProps) {
  const { t } = useTranslation('wAdmin');

  function setOrigin(value: string) {
    const rest = omit(staged, 'origin');
    onStagedChange(value === ALL_VALUE ? rest : { ...rest, origin: value });
  }

  function setPrinterName(value: string) {
    const rest = omit(staged, 'printerName');
    onStagedChange(value ? { ...rest, printerName: value } : rest);
  }

  function setStatus(value: string) {
    const rest = omit(staged, 'status');
    onStagedChange(
      value === ALL_VALUE ? rest : { ...rest, status: PrintJobStatusSchema.parse(value) }
    );
  }

  function setDateFrom(value: string) {
    const rest = omit(staged, 'dateFrom');
    onStagedChange(value ? { ...rest, dateFrom: new Date(value) } : rest);
  }

  function setDateTo(value: string) {
    const rest = omit(staged, 'dateTo');
    onStagedChange(value ? { ...rest, dateTo: new Date(value) } : rest);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={staged.origin ?? ALL_VALUE} onValueChange={setOrigin}>
        <SelectTrigger
          id="print-job-filter-origin"
          aria-label={t('printJobFilterBar.allOrigins')}
          className="w-[160px]"
        >
          <SelectValue placeholder={t('printJobFilterBar.allOrigins')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{t('printJobFilterBar.allOrigins')}</SelectItem>
          {ORIGINS.map(origin => (
            <SelectItem key={origin} value={origin}>
              {origin}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={staged.printerName ?? ''}
        onChange={e => {
          setPrinterName(e.target.value);
        }}
        placeholder={t('printJobFilterBar.printerNamePlaceholder')}
        aria-label={t('printJobFilterBar.printerNamePlaceholder')}
        className="w-[180px]"
      />

      <Select value={staged.status ?? ALL_VALUE} onValueChange={setStatus}>
        <SelectTrigger aria-label={t('printJobFilterBar.allStatuses')} className="w-[180px]">
          <SelectValue placeholder={t('printJobFilterBar.allStatuses')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{t('printJobFilterBar.allStatuses')}</SelectItem>
          {PrintJobStatusSchema.options.map(status => (
            <SelectItem key={status} value={status}>
              {status}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FormField label={t('printJobFilterBar.dateFrom')}>
        <input
          type="date"
          value={toDateInputValue(staged.dateFrom)}
          onChange={e => {
            setDateFrom(e.target.value);
          }}
          className={DATE_INPUT_CLASS}
        />
      </FormField>
      <FormField label={t('printJobFilterBar.dateTo')}>
        <input
          type="date"
          value={toDateInputValue(staged.dateTo)}
          onChange={e => {
            setDateTo(e.target.value);
          }}
          className={DATE_INPUT_CLASS}
        />
      </FormField>

      <POSButton
        touchSize="default"
        onClick={() => {
          onApply(staged);
        }}
      >
        {t('printJobFilterBar.applyFilters')}
      </POSButton>
    </div>
  );
}

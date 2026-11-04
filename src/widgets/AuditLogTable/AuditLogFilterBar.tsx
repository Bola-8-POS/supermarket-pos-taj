/**
 * AuditLogFilterBar — five filter controls (Action, Entity type, Actor,
 * Date range, Search) + "Apply filters" button, rendered via DataTable's
 * `toolbar` prop on the `/audit` page.
 *
 * Filters are staged in the parent's local state and only committed to the
 * `useAuditLogs(filters)` call when "Apply filters" is clicked — matches the
 * E2E's explicit "click Apply filters" step (14-UI-SPEC.md section B).
 */
import { useTranslation } from 'react-i18next';

import type { AuditLogFilters } from '@entities/audit-log';
import { useStaffList } from '@entities/staff';
import { AuditActionSchema } from '@shared/lib/audit-actions';
import { FormField } from '@shared/ui/FormField';
import { POSButton } from '@shared/ui/POSButton';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

/** Sentinel value for the "All ..." option (Radix Select disallows value=""). */
const ALL_VALUE = '__all__';

/** Hardcoded entity-type list per 14-UI-SPEC.md section B — no new DB query needed. */
const ENTITY_TYPES = [
  'payment',
  'tab',
  'caja_session',
  'order',
  'combo',
  'inventory',
  'prep_production',
  'permission',
  'staff',
  'settings',
] as const;

export interface AuditLogFilterBarProps {
  staged: AuditLogFilters;
  onStagedChange: (next: AuditLogFilters) => void;
  onApply: (filters: AuditLogFilters) => void;
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

export function AuditLogFilterBar({ staged, onStagedChange, onApply }: AuditLogFilterBarProps) {
  const { t } = useTranslation('wAdmin');
  const { data: staffList } = useStaffList();

  function setAction(value: string) {
    const rest = omit(staged, 'action');
    onStagedChange(value === ALL_VALUE ? rest : { ...rest, action: value });
  }

  function setEntityType(value: string) {
    const rest = omit(staged, 'entityType');
    onStagedChange(value === ALL_VALUE ? rest : { ...rest, entityType: value });
  }

  function setActorId(value: string) {
    const rest = omit(staged, 'actorId');
    onStagedChange(value === ALL_VALUE ? rest : { ...rest, actorId: value });
  }

  function setDateFrom(value: string) {
    const rest = omit(staged, 'dateFrom');
    onStagedChange(value ? { ...rest, dateFrom: new Date(value) } : rest);
  }

  function setDateTo(value: string) {
    const rest = omit(staged, 'dateTo');
    onStagedChange(value ? { ...rest, dateTo: new Date(value) } : rest);
  }

  function setSearch(value: string) {
    const rest = omit(staged, 'search');
    onStagedChange(value ? { ...rest, search: value } : rest);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={staged.action ?? ALL_VALUE} onValueChange={setAction}>
        <SelectTrigger id="audit-filter-action" className="w-[180px]">
          <SelectValue placeholder={t('auditLogFilterBar.allActions')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{t('auditLogFilterBar.allActions')}</SelectItem>
          {AuditActionSchema.options.map(action => (
            <SelectItem key={action} value={action}>
              {action}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={staged.entityType ?? ALL_VALUE} onValueChange={setEntityType}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder={t('auditLogFilterBar.allEntities')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{t('auditLogFilterBar.allEntities')}</SelectItem>
          {ENTITY_TYPES.map(entityType => (
            <SelectItem key={entityType} value={entityType}>
              {entityType}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={staged.actorId ?? ALL_VALUE} onValueChange={setActorId}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder={t('auditLogFilterBar.allStaff')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{t('auditLogFilterBar.allStaff')}</SelectItem>
          {(staffList ?? []).map(staff => (
            <SelectItem key={staff.id} value={staff.id}>
              {staff.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FormField label={t('auditLogFilterBar.dateFrom')}>
        <input
          type="date"
          value={toDateInputValue(staged.dateFrom)}
          onChange={e => {
            setDateFrom(e.target.value);
          }}
          className={DATE_INPUT_CLASS}
        />
      </FormField>
      <FormField label={t('auditLogFilterBar.dateTo')}>
        <input
          type="date"
          value={toDateInputValue(staged.dateTo)}
          onChange={e => {
            setDateTo(e.target.value);
          }}
          className={DATE_INPUT_CLASS}
        />
      </FormField>

      <div className="flex flex-col gap-1">
        <Input
          value={staged.search ?? ''}
          onChange={e => {
            setSearch(e.target.value);
          }}
          placeholder={t('auditLogFilterBar.searchPlaceholder')}
          aria-label={t('auditLogFilterBar.searchAriaLabel')}
          className="w-[220px]"
        />
        <span className="text-xs text-muted-foreground">{t('auditLogFilterBar.searchHint')}</span>
      </div>

      <POSButton
        touchSize="default"
        onClick={() => {
          onApply(staged);
        }}
      >
        {t('auditLogFilterBar.applyFilters')}
      </POSButton>
    </div>
  );
}

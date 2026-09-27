import { useTranslation } from 'react-i18next';
import { DateRangePicker, FormField, Switch } from '@shared/ui';
import { PROMOTION_DATE_PRESETS } from '@shared/ui/DateRangePicker.presets';
import { Checkbox } from '@shared/ui/checkbox';

export interface StepValidityRecurrenceProps {
  fromStr: string;
  toStr: string;
  onDateRangeChange: (fromStr: string, toStr: string) => void;
  recurring: boolean;
  onRecurringChange: (checked: boolean) => void;
  daysOfWeek: number[] | null;
  onToggleDayOfWeek: (day: number) => void;
  startTime: string | null;
  endTime: string | null;
  onStartTimeChange: (value: string | null) => void;
  onEndTimeChange: (value: string | null) => void;
  /** True once the admin tried to advance past this step while it was invalid. */
  showValidationError: boolean;
  disabled?: boolean;
}

// Postgres EXTRACT(DOW) convention: 0=Sunday..6=Saturday (matches
// getStoreLocalDowAndTime's own DOW_MAP in promotion-pricing.ts).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Validity & Recurrence step of the promotion wizard (D-04/D-05/D-06/D-07,
 * D-08 forward-nav gate). DateRangePicker gets PROMOTION_DATE_PRESETS
 * (Task 1's forward-looking set) instead of Reports' own backward-looking
 * default. The "Recurring" toggle reveals day-of-week checkboxes + a
 * same-day time window only when on (D-04/D-05); toggling it off clears
 * those fields (handled by the caller's onRecurringChange).
 */
export function StepValidityRecurrence({
  fromStr,
  toStr,
  onDateRangeChange,
  recurring,
  onRecurringChange,
  daysOfWeek,
  onToggleDayOfWeek,
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
  showValidationError,
  disabled = false,
}: StepValidityRecurrenceProps) {
  const { t } = useTranslation('wAdmin');
  const dateRangeInvalid = toStr < fromStr;
  const timeWindowInvalid = startTime !== null && endTime !== null && endTime <= startTime;

  return (
    <div className="space-y-4">
      <DateRangePicker
        fromStr={fromStr}
        toStr={toStr}
        onChange={onDateRangeChange}
        presets={PROMOTION_DATE_PRESETS}
      />
      {showValidationError && dateRangeInvalid && (
        <p className="text-sm text-destructive" role="alert">
          {t('promotionWizard.validity.dateRangeError')}
        </p>
      )}

      <label className="flex items-center gap-2">
        <Switch checked={recurring} disabled={disabled} onCheckedChange={onRecurringChange} />
        <span className="text-sm font-medium">{t('promotionWizard.validity.recurringLabel')}</span>
      </label>

      {recurring && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {DAY_KEYS.map((key, day) => (
              <label
                key={key}
                className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-3 text-sm shadow-xs transition-colors has-data-[state=checked]:border-brand has-data-[state=checked]:bg-brand-soft has-data-[state=checked]:text-brand-strong"
              >
                <Checkbox
                  checked={(daysOfWeek ?? []).includes(day)}
                  disabled={disabled}
                  onCheckedChange={() => {
                    onToggleDayOfWeek(day);
                  }}
                />
                {t(`promotionWizard.validity.day.${key}`)}
              </label>
            ))}
          </div>

          <div className="flex flex-wrap gap-4">
            <FormField label={t('promotionWizard.validity.startTimeLabel')}>
              <input
                type="time"
                value={startTime ?? ''}
                disabled={disabled}
                onChange={e => {
                  onStartTimeChange(e.target.value || null);
                }}
                className="h-11 rounded-lg border border-input bg-card px-2 shadow-xs dark:bg-input/20 py-1 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
              />
            </FormField>
            <FormField label={t('promotionWizard.validity.endTimeLabel')}>
              <input
                type="time"
                value={endTime ?? ''}
                disabled={disabled}
                onChange={e => {
                  onEndTimeChange(e.target.value || null);
                }}
                className="h-11 rounded-lg border border-input bg-card px-2 shadow-xs dark:bg-input/20 py-1 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
              />
            </FormField>
          </div>

          {showValidationError && timeWindowInvalid && (
            <p className="text-sm text-destructive" role="alert">
              {t('promotionWizard.validity.timeWindowError')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

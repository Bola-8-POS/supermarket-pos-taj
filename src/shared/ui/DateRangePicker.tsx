import { useTranslation } from 'react-i18next';

import { PRESETS, type Preset } from './DateRangePicker.presets';
import { POSButton } from './POSButton';

export type DateRangePickerProps = {
  fromStr: string;
  toStr: string;
  onChange: (fromStr: string, toStr: string) => void;
  /** Optional preset override. Defaults to the backward-looking PRESETS (Reports' own
   *  call sites keep compiling and behaving identically). The promotion wizard passes
   *  PROMOTION_DATE_PRESETS instead (D-07's forward-looking-validity requirement). */
  presets?: Preset[];
};

export function DateRangePicker({
  fromStr,
  toStr,
  onChange,
  presets = PRESETS,
}: DateRangePickerProps) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2 shadow-xs">
      {presets.map(preset => (
        <POSButton
          key={preset.labelKey}
          variant="ghost"
          size="sm"
          touchSize="default"
          className="rounded-lg"
          onClick={() => {
            onChange(preset.from(), preset.to());
          }}
        >
          {t(preset.labelKey)}
        </POSButton>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('dateRangePicker.from')}</span>
        <input
          type="date"
          value={fromStr}
          onChange={e => {
            onChange(e.target.value, toStr);
          }}
          className="h-10 rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('dateRangePicker.to')}</span>
        <input
          type="date"
          value={toStr}
          onChange={e => {
            onChange(fromStr, e.target.value);
          }}
          className="h-10 rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-xs transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
        />
      </label>
    </div>
  );
}

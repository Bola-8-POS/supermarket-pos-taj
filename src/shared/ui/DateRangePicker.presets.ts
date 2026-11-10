/**
 * Preset date-range button definitions for DateRangePicker.tsx. Kept in a
 * co-located non-component file (per 28-04's plan text: "or a small
 * co-located helper") so DateRangePicker.tsx only exports the component
 * itself — a value export like PROMOTION_DATE_PRESETS alongside the
 * component trips `react-refresh/only-export-components`.
 */

export type Preset = { labelKey: string; from: () => string; to: () => string };

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

/** Backward-looking presets — Reports' own default, unchanged behavior. */
export const PRESETS: Preset[] = [
  {
    labelKey: 'dateRangePicker.today',
    from: () => toDateStr(new Date()),
    to: () => toDateStr(new Date()),
  },
  {
    labelKey: 'dateRangePicker.yesterday',
    from: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return toDateStr(d);
    },
    to: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return toDateStr(d);
    },
  },
  {
    labelKey: 'dateRangePicker.last7Days',
    from: () => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return toDateStr(d);
    },
    to: () => toDateStr(new Date()),
  },
  {
    labelKey: 'dateRangePicker.thisMonth',
    from: () => {
      const d = new Date();
      d.setDate(1);
      return toDateStr(d);
    },
    to: () => toDateStr(new Date()),
  },
];

// "Today onward" caps at +1 year — a concrete, documented far-future bound
// rather than an unbounded/indefinite range (D-07's forward-looking-validity
// requirement still needs SOME upper bound for the underlying date input).
const FAR_FUTURE_CAP_DAYS = 365;

/**
 * Forward-looking presets for the promotion wizard's Validity & Recurrence
 * step (D-07). Reports keeps its own backward-looking PRESETS default above
 * — this array is only ever passed explicitly via DateRangePicker's
 * `presets` prop, never the default.
 */
export const PROMOTION_DATE_PRESETS: Preset[] = [
  {
    labelKey: 'dateRangePicker.todayOnward',
    from: () => toDateStr(new Date()),
    to: () => {
      const d = new Date();
      d.setDate(d.getDate() + FAR_FUTURE_CAP_DAYS);
      return toDateStr(d);
    },
  },
  {
    labelKey: 'dateRangePicker.next7Days',
    from: () => toDateStr(new Date()),
    to: () => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return toDateStr(d);
    },
  },
  {
    labelKey: 'dateRangePicker.next30Days',
    from: () => toDateStr(new Date()),
    to: () => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return toDateStr(d);
    },
  },
  {
    labelKey: 'dateRangePicker.thisMonth',
    from: () => toDateStr(new Date()),
    to: () => {
      const d = new Date();
      // Day 0 of next month = last day of the current month.
      d.setMonth(d.getMonth() + 1, 0);
      return toDateStr(d);
    },
  },
];

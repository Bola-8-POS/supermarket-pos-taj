const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export const money = (n: number | null | undefined): string => mxn.format(n ?? 0);

export const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${String(Math.round(n * 10) / 10)}%`;

export const timeShort = (iso: string | Date): string =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

export const dateShort = (iso: string | Date): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const dateTime = (iso: string | Date): string => `${dateShort(iso)} ${timeShort(iso)}`;

export const dateLong = (d: Date): string =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/** "2h 15m" from two timestamps (second defaults to now). */
export const elapsed = (from: string | Date, to: string | Date = new Date()): string => {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${String(h)}h ${String(m)}m` : `${String(m)}m`;
};

export const daysUntil = (isoDate: string): number => {
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(isoDate));
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
};

export const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d';

export function rangeFor(key: RangeKey, now = new Date()): { from: Date; to: Date } {
  const today = startOfDay(now);
  const day = 86_400_000;
  switch (key) {
    case 'today':
      return { from: today, to: now };
    case 'yesterday':
      return { from: new Date(today.getTime() - day), to: today };
    case '7d':
      return { from: new Date(today.getTime() - 6 * day), to: now };
    case '30d':
      return { from: new Date(today.getTime() - 29 * day), to: now };
  }
}

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s.charAt(0).toUpperCase())
    .join('');

export const methodLabel: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  tab_transfer: 'Tab transfer',
  rappi: 'Rappi',
};
export const plural = (n: number, one: string, many = one + 's'): string => `${String(n)} ${n === 1 ? one : many}`;

import { z } from 'zod';
import { err, ok, type Result } from './result';

/** Backup alert codes in the order they are shown (worst first). Conventions §8.2 and the backup plan. */
export const BACKUP_ALERT_CODES = [
  'BACKUP_STALE_72H',
  'BACKUP_VERIFY_FAILED',
  'BACKUP_DEST_DOWN',
  'BACKUP_STALE_24H',
  'BACKUP_KEY_NOT_EXPORTED',
  'BACKUP_VERIFY_OVERDUE',
] as const;
export type BackupAlertCode = (typeof BACKUP_ALERT_CODES)[number];

const AlertSchema = z.object({
  code: z.string(),
  level: z.string(),
  // null for some server alerts (and a plan's alert may omit it)
  since: z.string().nullable().optional(),
  reason: z.string().optional(),
  dest: z.string().optional(),
  dests: z.array(z.string()).optional(),
});

export const StoreStatusSchema = z.object({
  schema: z.literal(1),
  generatedAt: z.string().optional(),
  // each alert is parsed on its own: one malformed alert (from any plan) is skipped, never the whole status
  alerts: z
    .array(z.unknown())
    .default([])
    .transform(items =>
      items.flatMap(item => {
        const r = AlertSchema.safeParse(item);
        return r.success ? [r.data] : [];
      })
    ),
  backup: z
    .object({
      alert: z.enum(['none', 'warn', 'critical']),
      destinations: z.array(z.object({ name: z.string(), ok: z.boolean() })).default([]),
    })
    .optional(),
});
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

/** A hosted Supabase project has no /_store/status; anything else may be a store server. */
export function isStoreServerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); // a trailing dot is the same host
    return !(host.endsWith('.supabase.co') || host.endsWith('.supabase.in'));
  } catch {
    return false;
  }
}

export function storeStatusUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/_store/status`;
}

export interface BackupAlertPick {
  /** The server's code: one of BACKUP_ALERT_CODES, or any other BACKUP_* code (shown with a generic message). */
  code: string;
  level: 'warn' | 'critical';
  names: string[];
  /** The server's reason for the alert, when it sent one (e.g. 'no-destination'). */
  reason?: string;
}

export function isListedBackupCode(code: string): code is BackupAlertCode {
  return (BACKUP_ALERT_CODES as readonly string[]).includes(code);
}

/** Worst first: critical before warn, then the listed codes in their order, then any other BACKUP_* code. */
export function pickBackupAlert(status: StoreStatus): BackupAlertPick | null {
  const rank = (c: string): number => {
    const i = (BACKUP_ALERT_CODES as readonly string[]).indexOf(c);
    return i >= 0 ? i : BACKUP_ALERT_CODES.length;
  };
  // the server's level word is compared case-insensitively, so a stray 'CRITICAL' is never shown as a warning
  const isCritical = (level: string): boolean => level.toLowerCase() === 'critical';
  const sev = (level: string): number => (isCritical(level) ? 0 : 1);
  const active = status.alerts.filter(a => a.code.startsWith('BACKUP_')).sort((a, b) => sev(a.level) - sev(b.level) || rank(a.code) - rank(b.code));
  const best = active[0];
  if (!best) return null;
  const names = best.dests ?? (best.dest ? [best.dest] : (status.backup?.destinations ?? []).filter(d => d.name !== 'local' && !d.ok).map(d => d.name));
  // never less severe than the server says: the worst of this alert and the block's own level
  const level = isCritical(best.level) || status.backup?.alert === 'critical' ? 'critical' : 'warn';
  return { code: best.code, level, names, ...(best.reason ? { reason: best.reason } : {}) };
}

const REQUEST_TIMEOUT_MS = 10_000;

export async function fetchStoreStatus(endpoint: { url: string; anonKey: string }, signal?: AbortSignal): Promise<Result<StoreStatus>> {
  // the caller's signal and a 10 s timeout, either of which cancels the request
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const onCallerAbort = (): void => {
    ctrl.abort();
  };
  if (signal?.aborted) ctrl.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    const res = await fetch(storeStatusUrl(endpoint.url), { headers: { apikey: endpoint.anonKey }, signal: ctrl.signal });
    if (!res.ok) return err({ code: 'NOT_FOUND', message: `status endpoint answered ${String(res.status)}` });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // a timeout or the caller's abort while the body streams is a lost connection, not a bad body
      if (ctrl.signal.aborted) return err({ code: 'NETWORK_OFFLINE', message: 'store server unreachable' });
      return err({ code: 'VALIDATION_ERROR', message: 'status body is not JSON' });
    }
    const parsed = StoreStatusSchema.safeParse(body);
    return parsed.success ? ok(parsed.data) : err({ code: 'VALIDATION_ERROR', message: 'unexpected status body' });
  } catch {
    return err({ code: 'NETWORK_OFFLINE', message: 'store server unreachable' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

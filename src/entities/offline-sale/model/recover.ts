import type { z } from 'zod';
import { logger } from '@shared/lib/logger-instance';
import { OfflineSaleSchema, type OfflineSale } from '@shared/lib/offline-sale-schema';
/* eslint-disable i18next/no-literal-string -- log event names and a stored
   diagnostic message, not UI copy. */

/**
 * Rehydration of the persisted sale list (Review Focus: never discard the
 * whole list, and never lose a sale without a trace).
 *
 * Tier 0: the record parses: kept (a record left `replaying` by a killed app
 *         goes back to `queued`, attempts untouched; the same idempotency key
 *         makes the re-send safe).
 * Tier 1: the core (id, request, soldAt, staffId, staffName, receiptNumber,
 *         integrity) parses but another field does not: salvaged as
 *         `needs_review`; UNKNOWN naming the bad fields unless a valid stored
 *         refusal code exists, which is kept. A stored terminal
 *         status (confirmed / resolved) is kept: a confirmed sale is never
 *         re-opened for review.
 *         Damage confined to `lines` (display names) is not a tier-1 case: the
 *         sale is kept as is with empty lines.
 * Tier 2: the core does not parse: dropped alone, logged at error with the
 *         identifying fields, which are then the only trace of the sale.
 */

const CoreSchema = OfflineSaleSchema.pick({
  id: true,
  request: true,
  soldAt: true,
  staffId: true,
  staffName: true,
  receiptNumber: true,
  integrity: true,
});

const SALVAGE_KEYS = [
  'lines',
  'reRingAttemptKeys',
  'resolutionOutcomeUnknown',
  'status',
  'attempts',
  'lastCode',
  'lastMessage',
  'nextAttemptAt',
  'tabId',
  'confirmedReceipt',
  'confirmedAt',
  'slimmed',
  'resolution',
  'resolvedBy',
  'resolvedAt',
  'linkedTabId',
  'customerOverpaid',
  'amountShort',
  'duplicateReringTabId',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pathsOf = (issues: readonly z.core.$ZodIssue[]): string[] => [
  ...new Set(issues.map(i => i.path.join('.') || '(root)')),
];

/** Identifying fields of a record that cannot be recovered, for the error log. */
function traceFields(entry: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!isRecord(entry)) return out;
  for (const key of ['id', 'receiptNumber', 'staffId', 'soldAt']) {
    const v = entry[key];
    if (typeof v === 'string') out[key] = v;
  }
  const request = entry.request;
  if (isRecord(request)) {
    for (const key of ['amount', 'expectedTotal']) {
      const v = request[key];
      if (typeof v === 'number') out[key] = v;
    }
  }
  return out;
}

function logUnrecoverable(entry: unknown, index: number, paths: string[]): void {
  logger.error('offline_sale.record_unrecoverable', { index, paths, ...traceFields(entry) });
}

export function recoverRecord(entry: unknown, index: number): OfflineSale | undefined {
  const asRecovered = (sale: OfflineSale): OfflineSale =>
    sale.status === 'replaying' ? { ...sale, status: 'queued', nextAttemptAt: undefined } : sale;

  const full = OfflineSaleSchema.safeParse(entry);
  if (full.success) return asRecovered(full.data);

  // Display names are never worth a review: damage confined to `lines` keeps the
  // sale exactly as it is and the receipt prints without names. The same holds for a
  // damaged `reRingAttemptKeys` (an extra lookup key, not the sale): it reads as empty.
  if (
    isRecord(entry) &&
    full.error.issues.every(i => i.path[0] === 'lines' ||
        i.path[0] === 'reRingAttemptKeys' ||
        i.path[0] === 'resolutionOutcomeUnknown'
    )
  ) {
    const damaged = new Set(full.error.issues.map(i => i.path[0]));
    const bare = OfflineSaleSchema.safeParse({
      ...entry,
      ...(damaged.has('lines') ? { lines: [] } : {}),
      ...(damaged.has('reRingAttemptKeys') ? { reRingAttemptKeys: [] } : {}),
      ...(damaged.has('resolutionOutcomeUnknown') ? { resolutionOutcomeUnknown: false } : {}),
    });
    if (bare.success) {
      logger.warn('offline_sale.lines_unreadable', { index, saleId: bare.data.id });
      return asRecovered(bare.data);
    }
  }

  const core = CoreSchema.safeParse(entry);
  if (!core.success || !isRecord(entry)) {
    logUnrecoverable(entry, index, pathsOf(full.error.issues));
    return undefined;
  }

  const shape: Record<string, z.ZodType> = OfflineSaleSchema.shape;
  const candidate: Record<string, unknown> = { ...core.data };
  const failed: string[] = [];
  for (const key of SALVAGE_KEYS) {
    const parsed = shape[key]?.safeParse(entry[key]);
    if (parsed?.success) {
      if (parsed.data !== undefined) candidate[key] = parsed.data;
    } else {
      failed.push(key);
    }
  }
  candidate.attempts ??= 0;

  const keepsStatus = candidate.status === 'confirmed' || candidate.status === 'resolved';
  if (!keepsStatus) {
    candidate.status = 'needs_review';
    // a stored refusal code (and its message) that is itself valid is the better diagnosis: keep it
    if (candidate.lastCode === undefined) {
      candidate.lastCode = 'UNKNOWN';
      candidate.lastMessage = `Stored record had unreadable fields: ${failed.join(', ')}`;
    }
    candidate.nextAttemptAt = undefined;
  }

  const salvaged = OfflineSaleSchema.safeParse(candidate);
  if (!salvaged.success) {
    logUnrecoverable(entry, index, pathsOf(salvaged.error.issues));
    return undefined;
  }
  logger.warn('offline_sale.record_salvaged', {
    index,
    saleId: salvaged.data.id,
    status: salvaged.data.status,
    fields: failed,
  });
  return salvaged.data;
}

/** Validates the persisted `records` value record by record. */
export function recoverRecords(persisted: unknown): OfflineSale[] {
  if (persisted === undefined || persisted === null) return [];
  const raw = isRecord(persisted) ? persisted.records : undefined;
  if (!Array.isArray(raw)) {
    logger.error('offline_sale.persisted_records_not_a_list', { found: typeof raw });
    return [];
  }
  return raw.flatMap((entry: unknown, index) => recoverRecord(entry, index) ?? []);
}

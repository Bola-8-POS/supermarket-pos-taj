import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logger } from '@shared/lib/logger-instance';
import { OfflineSaleSchema, type OfflineSale } from '@shared/lib/offline-sale-schema';
import { err, ok, type Result } from '@shared/lib/result';
import { isNonTerminal, OFFLINE_SALE_LIMITS } from './limits';
import { applyOfflineSaleEvent, type OfflineSaleEvent } from './machine';
import { recoverRecords } from './recover';
/* eslint-disable i18next/no-literal-string -- zustand persist store name below
   is a localStorage key, and error messages are developer diagnostics, not UI copy. */

export type EnqueueOfflineSaleInput = Pick<
  OfflineSale,
  'id' | 'request' | 'lines' | 'soldAt' | 'staffId' | 'staffName' | 'receiptNumber' | 'integrity'
>;

interface OfflineSaleState {
  records: OfflineSale[];
  /** Memory only (not persisted): the last write failed even after settled sales gave way, so the till's sale storage is full. */
  storageFull: boolean;
}

interface OfflineSaleActions {
  /**
   * Validates and stores a queued sale. The stored record is the parsed form
   * (what rehydration would produce), so nothing accepted here can vanish at
   * the next start; compute `integrity` with `computeSaleIntegrity`, which
   * hashes that same form. Returns the EXISTING record when one already holds
   * the same idempotency key (double tap, retry of the hand-off). Fails, and
   * adds nothing, when the record is invalid, reuses an id, or cannot be
   * written to storage: the caller must not clear the cart on failure.
   */
  enqueueOfflineSale: (input: EnqueueOfflineSaleInput) => Result<OfflineSale>;
  /**
   * Runs the state machine. `undefined` = unknown id. `ignored` = the event is
   * impossible in the current status (nothing changed, nothing to write).
   * `persisted: false` = the event applies but the storage write failed: memory
   * is rolled back to the previous record and the error is logged, so the
   * caller must retry the write or raise a storage fault; it must not treat
   * the event as applied or as merely ignored.
   */
  applyEvent: (
    id: string,
    event: OfflineSaleEvent,
    now?: number
  ) => { record: OfflineSale; ignored: boolean; persisted: boolean } | undefined;
  /** Drops confirmed / resolved records older than the retention window. The only way a record leaves. */
  purge: (now: number) => void;
  /** Drops every confirmed / resolved record whatever its age: the purge after a successful caja close (Ruling 17). Non-terminal records stay. */
  purgeSettled: () => void;
}

type OfflineSaleStore = OfflineSaleState & OfflineSaleActions;

/** When a terminal record settled; falls back to the sale time when the stamp is missing. */
const settledAt = (r: OfflineSale): number =>
  Date.parse((r.status === 'confirmed' ? r.confirmedAt : r.resolvedAt) ?? r.soldAt);

/** Relief order under storage pressure (R72): settled records only, `confirmed` before `resolved`, oldest first. */
const reliefOrder = (records: readonly OfflineSale[]): OfflineSale[] =>
  records
    .filter(r => !isNonTerminal(r))
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || settledAt(a) - settledAt(b));

const logRelief = (event: 'slimmed' | 'evicted', r: OfflineSale): void => {
  logger.warn(`offline_sale.storage_${event}`, {
    saleId: r.id,
    receiptNumber: r.receiptNumber,
    linkedTabId: r.tabId ?? r.linkedTabId,
    status: r.status,
  });
};

/** Batch sizes tried under pressure: 8, 16, 32 ... then everything; each try is one full write of the blob. */
const reliefBatches = (total: number): number[] => {
  const sizes: number[] = [];
  for (let n = 8; n < total; n *= 2) sizes.push(n);
  if (total > 0) sizes.push(total);
  return sizes;
};

/** Drops the receipt and display lines of a settled record; the sale itself stays (tab id, request, status). */
const slim = (r: OfflineSale): OfflineSale => ({ ...r, confirmedReceipt: undefined, lines: [], slimmed: true });

export const useOfflineSaleStore = create<OfflineSaleStore>()(
  persist(
    (set, get) => {
      // zustand persist runs set() and THEN writes storage, so a quota error
      // throws out of set() after memory changed. Restore memory (its own
      // write is expected to fail the same way) so memory never claims a sale
      // that disk does not hold.
      const rollback = (restore: (records: OfflineSale[]) => OfflineSale[]): void => {
        try {
          set(state => ({ records: restore(state.records) }));
        } catch {
          // memory is already restored; the write fails again, as expected
        }
      };

      /**
       * Writes `next(records)`. On a storage failure, frees space ONCE over and retries (R72):
       * A) slim the oldest settled records, B) remove the oldest settled records, in doubling
       * batches so only as many as needed go. A pending record (queued / replaying / needs_review)
       * is never slimmed, removed or rewritten: only settled ones are candidates, and the relief
       * array keeps every other record object as is. Memory ends either on the written state or
       * back on the previous one; `storageFull` says which.
       */
      const commit = (
        next: (records: OfflineSale[]) => OfflineSale[]
      ): { ok: true } | { ok: false; error: unknown } => {
        const before = get().records;
        let failure: unknown;
        const tryWrite = (records: OfflineSale[]): boolean => {
          try {
            set({ records: next(records), storageFull: false });
            return true;
          } catch (error) {
            failure ??= error;
            return false;
          }
        };
        if (tryWrite(before)) return { ok: true };

        const candidates = reliefOrder(before);
        const slimmable = candidates.filter(r => r.confirmedReceipt !== undefined || r.lines.length > 0);
        for (const n of reliefBatches(slimmable.length)) {
          const victims = new Set(slimmable.slice(0, n).map(r => r.id));
          if (tryWrite(before.map(r => (victims.has(r.id) ? slim(r) : r)))) {
            slimmable.slice(0, n).forEach(r => {
              logRelief('slimmed', r);
            });
            return { ok: true };
          }
        }
        const allSlimmed = before.map(r => (slimmable.some(v => v.id === r.id) ? slim(r) : r));
        for (const n of reliefBatches(candidates.length)) {
          const victims = new Set(candidates.slice(0, n).map(r => r.id));
          if (tryWrite(allSlimmed.filter(r => !victims.has(r.id)))) {
            slimmable.forEach(r => {
              logRelief('slimmed', r);
            });
            candidates.slice(0, n).forEach(r => {
              logRelief('evicted', r);
            });
            return { ok: true };
          }
        }
        rollback(() => before);
        try {
          set({ storageFull: true });
        } catch {
          // memory flag is set even though the write behind it fails
        }
        return { ok: false, error: failure };
      };

      return {
        records: [],
        storageFull: false,

        enqueueOfflineSale: input => {
          const existing = get().records.find(
            r => r.request.idempotencyKey === input.request.idempotencyKey
          );
          if (existing) return ok(existing);
          if (get().records.some(r => r.id === input.id)) {
            return err({ code: 'DUPLICATE_ENTRY', message: 'Offline sale id already in use' });
          }

          const { items } = input.request;
          if (
            input.lines.length !== items.length ||
            input.lines.some((line, i) => line.productId !== items[i]?.productId)
          ) {
            logger.error('offline_sale.enqueue_invalid', { saleId: input.id, fields: ['lines'] });
            return err({
              code: 'VALIDATION_ERROR',
              message: 'Offline sale is invalid: lines do not match the request items',
            });
          }

          const parsed = OfflineSaleSchema.safeParse({ ...input, status: 'queued', attempts: 0 });
          if (!parsed.success) {
            const fields = [...new Set(parsed.error.issues.map(i => i.path.join('.')))];
            logger.error('offline_sale.enqueue_invalid', { saleId: input.id, fields });
            return err({
              code: 'VALIDATION_ERROR',
              message: `Offline sale is invalid: ${fields.join(', ')}`,
            });
          }

          const record = parsed.data;
          const written = commit(records => [...records, record]);
          if (!written.ok) {
            logger.error('offline_sale.persist_failed', { saleId: record.id }, written.error);
            return err({ code: 'UNKNOWN_ERROR', message: 'Offline sale could not be saved', raw: written.error });
          }
          logger.info('offline_sale.enqueued', { saleId: record.id });
          return ok(record);
        },

        applyEvent: (id, event, now = Date.now()) => {
          const current = get().records.find(r => r.id === id);
          if (!current) return undefined;
          const result = applyOfflineSaleEvent(current, event, now);
          if (result.ignored) return { ...result, persisted: true };
          const written = commit(records => records.map(r => (r.id === id ? result.record : r)));
          if (!written.ok) {
            logger.error('offline_sale.persist_failed', { saleId: id, event: event.type }, written.error);
            return { record: current, ignored: false, persisted: false };
          }
          logger.info('offline_sale.transition', {
            saleId: id,
            event: event.type,
            status: result.record.status,
          });
          return { ...result, persisted: true };
        },

        purge: now => {
          // Writes only when something goes: rewriting the unchanged list on every replay pass would
          // let a stale second app instance overwrite newer records on a timer (R25).
          const kept = get().records.filter(
            r => isNonTerminal(r) || now - settledAt(r) <= OFFLINE_SALE_LIMITS.confirmedRetentionMs
          );
          if (kept.length === get().records.length) return;
          set({ records: kept });
        },

        purgeSettled: () => {
          const kept = get().records.filter(isNonTerminal);
          if (kept.length === get().records.length) return;
          set({ records: kept });
        },
      };
    },
    {
      name: 'offline-sales',
      version: 1,
      partialize: state => ({ records: state.records }),
      // Pass any older/newer persisted state straight to merge: without this,
      // zustand drops the whole stored state on a version mismatch. Per-record
      // validation in merge is the only filter.
      migrate: persisted => persisted as Pick<OfflineSaleState, 'records'>,
      merge: (persisted, current) => ({ ...current, records: recoverRecords(persisted) }),
      // An unparseable stored blob or a throw while merging would otherwise be
      // swallowed by zustand.
      onRehydrateStorage: () => (_state, error) => {
        if (error) logger.error('offline_sale.rehydrate_failed', {}, error);
      },
    }
  )
);

type Selectable = Pick<OfflineSaleState, 'records'>;

/** Waiting to be (re)played. */
export const selectPending = (s: Selectable): OfflineSale[] =>
  s.records.filter(r => r.status === 'queued' || r.status === 'replaying');

export const selectNeedsReview = (s: Selectable): OfflineSale[] =>
  s.records.filter(r => r.status === 'needs_review');

/** Records that block close caja (Ruling 13); sign-out and clock-out use `selectPending` (D1). */
export const selectBlocking = (s: Selectable): OfflineSale[] =>
  s.records.filter(
    r => r.status === 'queued' || r.status === 'replaying' || r.status === 'needs_review'
  );

/**
 * The next sale this cashier may replay: strict FIFO by `soldAt`, one in
 * flight (Ruling 8). A head of line still backing off holds the queue so an
 * older sale is never overtaken (stock arbitration order, Ruling 18).
 */
export const selectNextForReplay =
  (staffId: string, now: number = Date.now()) =>
  (s: Selectable): OfflineSale | undefined => {
    if (s.records.some(r => r.status === 'replaying')) return undefined;
    const head = s.records
      .filter(r => r.status === 'queued' && r.staffId === staffId)
      .sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt))[0];
    if (!head) return undefined;
    return head.nextAttemptAt !== undefined && Date.parse(head.nextAttemptAt) > now ? undefined : head;
  };

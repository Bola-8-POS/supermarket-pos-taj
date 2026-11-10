import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@shared/lib/logger-instance';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { computeSaleIntegrity, verifySaleIntegrity } from './integrity';
import type { OfflineSaleEvent } from './machine';
import { makeSale } from './offline-sale.fixtures';
import {
  selectBlocking,
  selectNeedsReview,
  selectNextForReplay,
  selectPending,
  useOfflineSaleStore,
} from './store';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR = 3_600_000;
const STAFF_B = '88888888-8888-4888-8888-888888888888';
const MANAGER = '77777777-7777-4777-8777-777777777777';

type EnqueueInput = Parameters<ReturnType<typeof useOfflineSaleStore.getState>['enqueueOfflineSale']>[0];

function input(overrides: Partial<OfflineSale> = {}): EnqueueInput {
  const { status, attempts, ...rest } = makeSale(overrides);
  void status;
  void attempts;
  return rest;
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this`
const warn = logger.warn;
// eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this`
const logError = logger.error;
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = (records: OfflineSale[]) => useOfflineSaleStore.setState({ records });
const records = () => useOfflineSaleStore.getState().records;
const enqueueResult = (overrides: Partial<OfflineSale> = {}) =>
  useOfflineSaleStore.getState().enqueueOfflineSale(input(overrides));
function enqueue(overrides: Partial<OfflineSale> = {}): OfflineSale {
  const r = enqueueResult(overrides);
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
}
const failWrites = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  seed([]);
  vi.clearAllMocks();
});

describe('offline sale store', () => {
  it('enqueue stores a queued record with zero attempts', () => {
    const rec = enqueue();
    expect(rec).toMatchObject({ status: 'queued', attempts: 0 });
    expect(records()).toEqual([rec]);
  });

  it('enqueue with an existing key returns the same record and does not add one', () => {
    const first = enqueue();
    const again = enqueue({ id: idOf(2) });
    expect(again).toBe(first);
    expect(records()).toHaveLength(1);
  });

  it('enqueue refuses a record that would not survive rehydration', () => {
    const sale = makeSale();
    const result = enqueueResult({ request: { ...sale.request, amount: 9.001 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(records()).toEqual([]);
    expect(localStorage.getItem('offline-sales')).not.toContain(sale.request.idempotencyKey);
  });

  it('enqueue refuses lines that do not match the request items', () => {
    const sale = makeSale();
    const [line] = sale.lines;
    if (!line) throw new Error('fixture has a line');
    for (const lines of [[], [line, line], [{ ...line, productId: idOf(9) }]]) {
      const result = enqueueResult({ lines });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR');
    }
    expect(records()).toEqual([]);
  });

  it('enqueue refuses a duplicate id under a different key', () => {
    const first = enqueue();
    const sale = makeSale();
    const result = enqueueResult({ request: { ...sale.request, idempotencyKey: 'another_key' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DUPLICATE_ENTRY');
    expect(records()).toEqual([first]);
  });

  it('a record enqueued with a real hash still verifies after rehydrate', async () => {
    const sale = makeSale();
    // a request carrying a key the schema does not know: rehydration strips it
    const request = { ...sale.request, surplus: 'x' } as typeof sale.request;
    const integrity = await computeSaleIntegrity(request, sale.soldAt, sale.receiptNumber);
    enqueue({ request, integrity });
    await useOfflineSaleStore.persist.rehydrate();
    const stored = records()[0];
    expect(stored).toBeDefined();
    expect(stored?.request).not.toHaveProperty('surplus');
    if (stored) expect(await verifySaleIntegrity(stored)).toBe(true);
  });

  it('a failed storage write leaves no record and a retry attempts the write again', () => {
    const spy = failWrites();
    const failed = enqueueResult();
    spy.mockRestore();
    expect(failed.ok).toBe(false);
    expect(records()).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      'offline_sale.persist_failed',
      expect.anything(),
      expect.anything()
    );
    const retry = enqueueResult();
    expect(retry.ok).toBe(true);
    expect(records()).toHaveLength(1);
    expect(localStorage.getItem('offline-sales')).toContain(makeSale().request.idempotencyKey);
  });

  it('a failed status write is reported as not persisted, not as ignored', () => {
    const rec = enqueue();
    vi.clearAllMocks();
    const spy = failWrites();
    const result = useOfflineSaleStore.getState().applyEvent(rec.id, { type: 'replayStarted' }, NOW);
    spy.mockRestore();
    expect(result).toMatchObject({ ignored: false, persisted: false });
    expect(result?.record.status).toBe('queued');
    expect(records()[0]?.status).toBe('queued');
    expect(logError).toHaveBeenCalledWith(
      'offline_sale.persist_failed',
      expect.anything(),
      expect.anything()
    );
  });

  it('applyEvent moves the record and reports unknown ids and ignored events', () => {
    const rec = enqueue();
    const { applyEvent } = useOfflineSaleStore.getState();
    expect(applyEvent(rec.id, { type: 'replayStarted' }, NOW)).toMatchObject({
      ignored: false,
      persisted: true,
    });
    expect(records()[0]?.status).toBe('replaying');
    expect(applyEvent(rec.id, { type: 'replayStarted' }, NOW)).toMatchObject({
      ignored: true,
      persisted: true,
    });
    expect(applyEvent(idOf(9), { type: 'replayStarted' }, NOW)).toBeUndefined();
  });

  it('purge removes only confirmed or resolved older than retention', () => {
    const old = new Date(NOW - 49 * HOUR).toISOString();
    const fresh = new Date(NOW - 47 * HOUR).toISOString();
    seed([
      makeSale({ id: idOf(1), status: 'confirmed', confirmedAt: old }),
      makeSale({ id: idOf(2), status: 'confirmed', confirmedAt: fresh }),
      makeSale({ id: idOf(3), status: 'resolved', resolvedAt: old }),
      makeSale({ id: idOf(4), status: 'resolved', resolvedAt: fresh }),
      makeSale({ id: idOf(5), status: 'queued', soldAt: old }),
      makeSale({ id: idOf(6), status: 'needs_review', soldAt: old }),
      makeSale({ id: idOf(7), status: 'replaying', soldAt: old }),
    ]);
    useOfflineSaleStore.getState().purge(NOW);
    expect(records().map(r => r.id)).toEqual([idOf(2), idOf(4), idOf(5), idOf(6), idOf(7)]);
  });

  it('purgeSettled removes every confirmed and resolved record regardless of age and keeps the rest', () => {
    seed([
      makeSale({ id: idOf(1), status: 'confirmed', confirmedAt: new Date(NOW - HOUR).toISOString() }),
      makeSale({ id: idOf(2), status: 'resolved', resolvedAt: new Date(NOW).toISOString() }),
      makeSale({ id: idOf(3), status: 'queued' }),
      makeSale({ id: idOf(4), status: 'needs_review' }),
      makeSale({ id: idOf(5), status: 'replaying' }),
    ]);
    useOfflineSaleStore.getState().purgeSettled();
    expect(records().map(r => r.id)).toEqual([idOf(3), idOf(4), idOf(5)]);
  });

  it('purgeSettled writes nothing when no record is settled', () => {
    seed([makeSale({ id: idOf(1), status: 'queued' })]);
    const before = records();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    useOfflineSaleStore.getState().purgeSettled();
    expect(writes).not.toHaveBeenCalled();
    expect(records()).toBe(before);
  });

  it('purge writes nothing when there is nothing to purge', () => {
    seed([
      makeSale({ id: idOf(1), status: 'queued' }),
      makeSale({ id: idOf(2), status: 'confirmed', confirmedAt: new Date(NOW - HOUR).toISOString() }),
    ]);
    const before = records();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    useOfflineSaleStore.getState().purge(NOW);
    expect(writes).not.toHaveBeenCalled();
    expect(records()).toBe(before);

    seed([makeSale({ id: idOf(3), status: 'confirmed', confirmedAt: new Date(NOW - 49 * HOUR).toISOString() })]);
    writes.mockClear();
    useOfflineSaleStore.getState().purge(NOW);
    expect(writes).toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it('a malformed persisted record is dropped alone and logged', async () => {
    const good = makeSale({ id: idOf(1) });
    const broken = { ...makeSale({ id: idOf(3), receiptNumber: 'P-333333' }), staffId: 'not-a-uuid' };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({
        state: { records: [good, broken, 'garbage', makeSale({ id: idOf(2) })] },
        version: 1,
      })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records().map(r => r.id)).toEqual([idOf(1), idOf(2)]);
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      'offline_sale.record_unrecoverable',
      expect.objectContaining({
        index: 1,
        paths: ['staffId'],
        id: idOf(3),
        receiptNumber: 'P-333333',
        staffId: 'not-a-uuid',
        soldAt: '2026-10-09T10:00:00.000Z',
        amount: 9,
        expectedTotal: 9,
      })
    );
  });

  it('a record whose core is valid but a derived field is not is kept for review', async () => {
    const damaged = { ...makeSale({ id: idOf(1) }), attempts: -1, nextAttemptAt: 12345, lastCode: 'NOPE' };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [damaged] }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    const [rec] = records();
    expect(records()).toHaveLength(1);
    expect(rec).toMatchObject({ id: idOf(1), status: 'needs_review', lastCode: 'UNKNOWN', attempts: 0 });
    expect(rec?.nextAttemptAt).toBeUndefined();
    expect(rec?.lastMessage).toContain('attempts');
    expect(rec?.lastMessage).toContain('nextAttemptAt');
    expect(rec?.lastMessage).toContain('lastCode');
    expect(warn).toHaveBeenCalledWith('offline_sale.record_salvaged', expect.anything());
  });

  it('a record with unreadable lines is kept and prints without names', async () => {
    const damaged = { ...makeSale({ id: idOf(1) }), lines: [{ productId: 5 }] };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [damaged] }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ id: idOf(1), status: 'queued', lines: [] });
  });

  it('a salvaged record keeps its valid lines', async () => {
    const sale = makeSale({ id: idOf(1) });
    const damaged = { ...sale, attempts: -1 };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [damaged] }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()[0]).toMatchObject({ status: 'needs_review', lines: sale.lines });
  });

  it('a salvaged record keeps a valid stored refusal code', async () => {
    const damaged = {
      ...makeSale({
        id: idOf(1),
        status: 'needs_review',
        attempts: 3,
        lastCode: 'PRICE_MISMATCH',
        lastMessage: 'price changed',
      }),
      resolvedAt: 12345,
    };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [damaged] }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()[0]).toMatchObject({
      status: 'needs_review',
      attempts: 3,
      lastCode: 'PRICE_MISMATCH',
      lastMessage: 'price changed',
    });
    expect(records()[0]?.resolvedAt).toBeUndefined();
  });

  it('a confirmed record with an invalid optional field stays confirmed', async () => {
    const damaged = { ...makeSale({ id: idOf(1), status: 'confirmed', attempts: 2 }), tabId: 'bad' };
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [damaged] }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()[0]).toMatchObject({ status: 'confirmed', attempts: 2 });
    expect(records()[0]?.tabId).toBeUndefined();
  });

  it('a persisted state from another version keeps its valid records', async () => {
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: [makeSale({ id: idOf(1) })] }, version: 0 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records().map(r => r.id)).toEqual([idOf(1)]);
  });

  it('an unreadable persisted blob is logged and does not throw', async () => {
    localStorage.setItem('offline-sales', '{not json');
    await expect(useOfflineSaleStore.persist.rehydrate()).resolves.not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      'offline_sale.rehydrate_failed',
      expect.anything(),
      expect.anything()
    );
  });

  it('persisted records that are not a list are logged', async () => {
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({ state: { records: { a: 1 } }, version: 1 })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()).toEqual([]);
    expect(logError).toHaveBeenCalledWith('offline_sale.persisted_records_not_a_list', expect.anything());
  });

  it('a record left replaying at startup returns to queued without counting an attempt', async () => {
    localStorage.setItem(
      'offline-sales',
      JSON.stringify({
        state: { records: [makeSale({ id: idOf(1), status: 'replaying', attempts: 2 })] },
        version: 1,
      })
    );
    await useOfflineSaleStore.persist.rehydrate();
    expect(records()[0]).toMatchObject({ status: 'queued', attempts: 2 });
  });

  it('persists only the records under the offline-sales key', () => {
    enqueue();
    expect(Object.keys(localStorage)).toEqual(['offline-sales']);
    const stored = JSON.parse(localStorage.getItem('offline-sales') ?? '{}') as {
      state: Record<string, unknown>;
      version: number;
    };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.state)).toEqual(['records']);
  });

  it('selectors split pending, needs-review and blocking records', () => {
    seed([
      makeSale({ id: idOf(1), status: 'queued' }),
      makeSale({ id: idOf(2), status: 'replaying' }),
      makeSale({ id: idOf(3), status: 'needs_review' }),
      makeSale({ id: idOf(4), status: 'confirmed' }),
      makeSale({ id: idOf(5), status: 'resolved' }),
    ]);
    const s = useOfflineSaleStore.getState();
    expect(selectPending(s).map(r => r.id)).toEqual([idOf(1), idOf(2)]);
    expect(selectNeedsReview(s).map(r => r.id)).toEqual([idOf(3)]);
    expect(selectBlocking(s).map(r => r.id)).toEqual([idOf(1), idOf(2), idOf(3)]);
  });

  it('selectNextForReplay returns the oldest due queued record of that cashier, one in flight', () => {
    const t = (h: number) => new Date(NOW - h * HOUR).toISOString();
    const state = (recs: OfflineSale[]) => ({ ...useOfflineSaleStore.getState(), records: recs });
    const mine = makeSale().staffId;
    const recs = [
      makeSale({ id: idOf(1), soldAt: t(1) }),
      makeSale({ id: idOf(2), soldAt: t(3) }),
      makeSale({ id: idOf(3), soldAt: t(5), staffId: STAFF_B }),
    ];
    expect(selectNextForReplay(mine, NOW)(state(recs))?.id).toBe(idOf(2));
    expect(selectNextForReplay(STAFF_B, NOW)(state(recs))?.id).toBe(idOf(3));
    // head of line is backing off: nothing younger jumps ahead of it
    const backing = [
      makeSale({ id: idOf(2), soldAt: t(3), nextAttemptAt: new Date(NOW + 1000).toISOString() }),
      recs[0] as OfflineSale,
    ];
    expect(selectNextForReplay(mine, NOW)(state(backing))).toBeUndefined();
    expect(selectNextForReplay(mine, NOW + 2000)(state(backing))?.id).toBe(idOf(2));
    // one in flight at a time
    const inFlight = [makeSale({ id: idOf(1), status: 'replaying' }), recs[1] as OfflineSale];
    expect(selectNextForReplay(mine, NOW)(state(inFlight))).toBeUndefined();
  });

  it('no event sequence removes a non-terminal record or lets a terminal one change status', () => {
    const tab = '66666666-6666-4666-8666-666666666666';
    const eventArb = fc.constantFrom<OfflineSaleEvent>(
      { type: 'replayStarted' },
      { type: 'unreachable' },
      { type: 'refused', code: 'INVALID_ITEMS', message: 'm' },
      { type: 'failedUnknown', message: 'm' },
      { type: 'retryRequested' },
      { type: 'resolved', resolution: 'written_off', by: MANAGER },
      { type: 'tampered' },
      { type: 'confirmed', tabId: tab, receipt: { receiptNumber: 'X', tabId: tab } as never }
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), events => {
        seed([]);
        const rec = enqueue();
        let before = rec.status;
        for (const event of events) {
          useOfflineSaleStore.getState().applyEvent(rec.id, event, NOW);
          const after = records().find(r => r.id === rec.id);
          expect(after).toBeDefined();
          if (before === 'confirmed' || before === 'resolved') expect(after?.status).toBe(before);
          before = after?.status ?? before;
        }
        expect(records()).toHaveLength(1);
      })
    );
  });
});

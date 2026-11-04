/* eslint-disable @typescript-eslint/unbound-method -- vi.fn() mocks and Storage.prototype methods are saved and restored, never called detached */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@shared/lib/logger-instance';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { makeHeavySale, makeServerReceipt, STORAGE_QUOTA_CHARS } from './offline-sale.fixtures';
import { useOfflineSaleStore } from './store';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const store = () => useOfflineSaleStore.getState();
const records = () => store().records;
const find = (id: string | undefined) => records().find(r => r.id === id);

// The browser counts key + value length across the whole origin; this backing store does the same.
// jsdom's own localStorage retains ~4 MB per large write, which 1,000+ writes of this suite turn into
// an out-of-memory crash, so Storage is backed by a Map here instead.
const proto = Storage.prototype;
const originals = {
  getItem: proto.getItem,
  setItem: proto.setItem,
  removeItem: proto.removeItem,
  clear: proto.clear,
};
let quota = STORAGE_QUOTA_CHARS;
let writes = 0;
const backing = new Map<string, string>();
function installStorage(): void {
  proto.getItem = (key: string) => backing.get(key) ?? null;
  proto.removeItem = (key: string) => {
    backing.delete(key);
  };
  proto.clear = () => {
    backing.clear();
  };
  proto.setItem = (key: string, value: string) => {
    writes += 1;
    let used = key.length + value.length;
    for (const [k, v] of backing) if (k !== key) used += k.length + v.length;
    if (used > quota) throw new DOMException('quota', 'QuotaExceededError');
    backing.set(key, value);
  };
}

const enqueueInput = (sale: OfflineSale) => {
  const { status, attempts, ...rest } = sale;
  void status;
  void attempts;
  return rest;
};
const enqueue = (n: number, msAgo = 0) => {
  const r = store().enqueueOfflineSale(enqueueInput(makeHeavySale(n, NOW - msAgo)));
  if (!r.ok) throw new Error(`enqueue ${String(n)}: ${r.error.message}`);
  return r.data;
};
const confirm = (sale: OfflineSale, at: number) => {
  store().applyEvent(sale.id, { type: 'replayStarted' }, at);
  return store().applyEvent(
    sale.id,
    { type: 'confirmed', tabId: sale.id, receipt: makeServerReceipt(sale) },
    at
  );
};
/** `count` confirmed heavy sales with a full server receipt, stored in one write (oldest first). */
const seedConfirmed = (count: number, firstN = 0): OfflineSale[] => {
  const done = Array.from({ length: count }, (_, i) => {
    const sale = makeHeavySale(firstN + i, NOW - 400_000 + i * 1000);
    return {
      ...sale,
      status: 'confirmed' as const,
      tabId: sale.id,
      confirmedAt: new Date(NOW - 200_000 + i * 1000).toISOString(),
      confirmedReceipt: makeServerReceipt(sale),
    };
  });
  useOfflineSaleStore.setState({ records: [...records(), ...done] });
  return done;
};
const storedChars = () => 'offline-sales'.length + (backing.get('offline-sales') ?? '').length;

beforeEach(() => {
  backing.clear();
  useOfflineSaleStore.setState({ records: [] });
  quota = STORAGE_QUOTA_CHARS;
  writes = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  Object.assign(proto, originals);
  vi.restoreAllMocks();
});

describe('offline sale storage pressure', () => {
  it('confirming 500 heavy sales never fails to store', { timeout: 120_000 }, () => {
    installStorage();
    const queued = Array.from({ length: 500 }, (_, n) => enqueue(n, (500 - n) * 1000));
    const writesBefore = writes;

    for (const [i, sale] of queued.entries()) {
      const res = confirm(sale, NOW + i * 1000);
      expect(res, `confirmation ${String(i)}`).toMatchObject({ persisted: true, ignored: false });
      if (i % 25 === 0) {
        // every sale not yet confirmed is still the very same object
        for (const later of queued.slice(i + 1)) expect(find(later.id)).toBe(later);
      }
    }

    expect(records().filter(r => r.status === 'confirmed')).toHaveLength(500);
    const slimmed = records().filter(r => r.slimmed === true).length;
    process.stdout.write(
      `[F5 measure] slimmed=${String(slimmed)} evicted=${String(500 - records().length)} ` +
        `writes=${String(writes - writesBefore)} (confirm = 2 transitions x 500) chars=${String(storedChars())}\n`
    );
    expect(storedChars()).toBeLessThanOrEqual(quota);
  });

  it('storage pressure slims the oldest confirmed sales first and never a pending one', () => {
    quota = Number.MAX_SAFE_INTEGER;
    installStorage();
    const confirmed = seedConfirmed(300);
    const queued = Array.from({ length: 200 }, (_, n) => enqueue(1000 + n, 100_000 - n * 100));
    quota = storedChars() + 100; // a 6.5k-char sale does not fit; slimming a few confirmed ones frees enough

    const extra = enqueue(5000);

    expect(find(extra.id)).toBeDefined();
    const slimmedIds = confirmed.filter(c => find(c.id)?.slimmed === true).map(c => c.id);
    expect(slimmedIds.length).toBeGreaterThan(0);
    expect(slimmedIds.length).toBeLessThan(300);
    // oldest first: the slimmed ones are exactly a prefix of the confirmation order
    expect(slimmedIds).toEqual(confirmed.slice(0, slimmedIds.length).map(c => c.id));
    const first = find(confirmed[0]?.id);
    expect(first).toMatchObject({ status: 'confirmed', slimmed: true, lines: [] });
    expect(first?.confirmedReceipt).toBeUndefined();
    expect(first?.tabId).toBeDefined(); // the link to the server sale survives
    expect(find(confirmed[299]?.id)?.confirmedReceipt).toBeDefined();
    // nothing evicted, no pending record touched
    expect(records()).toHaveLength(501);
    queued.forEach(q => {
      expect(find(q.id)).toBe(q);
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'offline_sale.storage_slimmed',
      expect.objectContaining({
        saleId: confirmed[0]?.id,
        receiptNumber: confirmed[0]?.receiptNumber,
        status: 'confirmed',
      })
    );
  });

  it('a new offline sale is stored after eviction when confirmed sales fill the store', { timeout: 120_000 }, () => {
    quota = Number.MAX_SAFE_INTEGER;
    installStorage();
    const done = seedConfirmed(500);
    quota = STORAGE_QUOTA_CHARS;

    const fresh: OfflineSale[] = [];
    for (let n = 0; n < 500; n += 1) fresh.push(enqueue(2000 + n, 1000 + n));

    expect(records().filter(r => r.status === 'queued')).toHaveLength(500);
    fresh.forEach(f => {
      expect(find(f.id)).toBe(f);
    });
    const evicted = done.filter(d => find(d.id) === undefined);
    expect(evicted.length).toBeGreaterThan(0);
    process.stdout.write(`[F5 measure] 500 confirmed + 500 new: evicted=${String(evicted.length)} slimmed-kept=${String(records().filter(r => r.slimmed === true).length)}
`);
    // the oldest confirmed went first
    expect(evicted.map(e => e.id)).toEqual(done.slice(0, evicted.length).map(e => e.id));
    expect(records().every(r => r.status === 'queued' || r.slimmed === true)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'offline_sale.storage_evicted',
      expect.objectContaining({ saleId: done[0]?.id, receiptNumber: done[0]?.receiptNumber })
    );
    expect(storedChars()).toBeLessThanOrEqual(STORAGE_QUOTA_CHARS);
  });

  it('a slimmed sale survives a reload', async () => {
    quota = Number.MAX_SAFE_INTEGER;
    installStorage();
    const done = seedConfirmed(3);
    quota = storedChars() + 100;
    enqueue(9000);
    const slimmed = find(done[0]?.id);
    expect(slimmed?.slimmed).toBe(true);

    const blob = backing.get('offline-sales') ?? '';
    useOfflineSaleStore.setState({ records: [] }); // the app closes: memory is gone, the blob is what the disk holds
    backing.set('offline-sales', blob);
    await useOfflineSaleStore.persist.rehydrate();

    const back = find(done[0]?.id);
    expect(back).toEqual(slimmed);
    expect(back).toMatchObject({ status: 'confirmed', slimmed: true, lines: [] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a full store of pending sales keeps failing closed and flags the storage fault', () => {
    quota = Number.MAX_SAFE_INTEGER;
    installStorage();
    Array.from({ length: 100 }, (_, n) => enqueue(n, 1000 + n));
    const before = [...records()];
    quota = storedChars() + 100;

    const res = store().enqueueOfflineSale(enqueueInput(makeHeavySale(777, NOW)));

    expect(res.ok).toBe(false);
    expect(records()).toHaveLength(100);
    records().forEach((r, i) => {
      expect(r).toBe(before[i]);
    });
    expect(store().storageFull).toBe(true);
    quota = Number.MAX_SAFE_INTEGER;
    enqueue(778);
    expect(store().storageFull).toBe(false);
  });
});

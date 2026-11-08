/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { computeSaleIntegrity, verifySaleIntegrity } from './integrity';
import { OFFLINE_SALE_LIMITS } from './limits';
import { makeSale } from './offline-sale.fixtures';
import { useOfflineSaleStore } from './store';

const SALE = makeSale().id;
const attempt = (key: string) => useOfflineSaleStore.getState().applyEvent(SALE, { type: 'reRingAttempted', key });
const keys = () => useOfflineSaleStore.getState().records.find(r => r.id === SALE)?.reRingAttemptKeys;

beforeEach(() => {
  localStorage.clear();
  useOfflineSaleStore.setState({ records: [makeSale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH' })] });
});

describe('re-ring attempt keys on the record', () => {
  it('attempt keys are deduplicated and bounded', () => {
    expect(attempt('k-1')).toMatchObject({ ignored: false, persisted: true });
    attempt('k-1');
    attempt('k-2');
    expect(keys()).toEqual(['k-1', 'k-2']);

    const cap = OFFLINE_SALE_LIMITS.maxReRingAttemptKeys;
    for (let n = 0; n < cap + 5; n += 1) attempt(`bulk-${String(n)}`);
    const kept = keys() ?? [];
    expect(kept).toHaveLength(cap);
    // the newest survive, the oldest go
    expect(kept.at(-1)).toBe(`bulk-${String(cap + 4)}`);
    expect(kept).not.toContain('k-1');
    // re-recording the newest changes nothing
    attempt(`bulk-${String(cap + 4)}`);
    expect(keys()).toEqual(kept);
  });

  it('is refused on a record that is not awaiting review', () => {
    useOfflineSaleStore.setState({ records: [makeSale({ status: 'resolved', resolution: 'rering' })] });
    expect(attempt('k-1')?.ignored).toBe(true);
    expect(keys()).toEqual([]);
  });

  it('a record without attempt keys rehydrates unchanged', async () => {
    const stored = { ...makeSale({ status: 'needs_review' }) } as Record<string, unknown>;
    delete stored.reRingAttemptKeys; // written by a build that did not know the field
    localStorage.setItem('offline-sales', JSON.stringify({ state: { records: [stored] }, version: 1 }));
    await useOfflineSaleStore.persist.rehydrate();
    const [rec] = useOfflineSaleStore.getState().records;
    expect(rec).toEqual(makeSale({ status: 'needs_review', reRingAttemptKeys: [] }));
  });

  it('a damaged attempt key list never drops the record', async () => {
    const stored = { ...makeSale({ status: 'needs_review' }), reRingAttemptKeys: 'oops' };
    localStorage.setItem('offline-sales', JSON.stringify({ state: { records: [stored] }, version: 1 }));
    await useOfflineSaleStore.persist.rehydrate();
    expect(useOfflineSaleStore.getState().records).toHaveLength(1);
    expect(keys()).toEqual([]);
  });

  it('attempt keys are not part of the integrity hash', async () => {
    const sale = makeSale();
    const integrity = await computeSaleIntegrity(sale.request, sale.soldAt, sale.receiptNumber);
    const withKeys = makeSale({ integrity, reRingAttemptKeys: ['k-1', 'k-2'] });
    expect(await verifySaleIntegrity(withKeys)).toBe(true);
    expect(await verifySaleIntegrity(makeSale({ integrity, reRingAttemptKeys: [] }))).toBe(true);
  });
});

describe('resolutionOutcomeUnknown on the record', () => {
  it('a record without the flag rehydrates unchanged', async () => {
    const stored = { ...makeSale({ status: 'needs_review' }) } as Record<string, unknown>;
    delete stored.resolutionOutcomeUnknown; // written by a build that did not know the field
    localStorage.setItem('offline-sales', JSON.stringify({ state: { records: [stored] }, version: 1 }));
    await useOfflineSaleStore.persist.rehydrate();
    const [rec] = useOfflineSaleStore.getState().records;
    expect(rec).toEqual(makeSale({ status: 'needs_review', resolutionOutcomeUnknown: false }));

    const damaged = { ...makeSale({ status: 'needs_review' }), resolutionOutcomeUnknown: 'oops' };
    localStorage.setItem('offline-sales', JSON.stringify({ state: { records: [damaged] }, version: 1 }));
    await useOfflineSaleStore.persist.rehydrate();
    expect(useOfflineSaleStore.getState().records).toHaveLength(1);
    expect(useOfflineSaleStore.getState().records[0]?.resolutionOutcomeUnknown).toBe(false);
  });
});

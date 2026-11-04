/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>>());
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

import { makeSale } from './offline-sale.fixtures';
import { completeReRing, reRingAdjustment, unlinkedReRingTab } from './rering';
import { useOfflineSaleStore } from './store';

const SALE = '11111111-1111-4111-8111-111111111111';
const MANAGER = '77777777-7777-4777-8777-777777777777';
const APPROVAL = '5f1e2d3c-4b5a-4c6d-8e7f-000000000001';
const NEW_TAB = '66666666-6666-4666-8666-666666666666';

const marker = { saleId: SALE, approvedBy: MANAGER, approvalId: APPROVAL, paidTotal: 9 };
const only = () => {
  const [first] = useOfflineSaleStore.getState().records;
  if (!first) throw new Error('no record');
  return first;
};
const failWrites = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: 'audit-id', error: null });
  useOfflineSaleStore.setState({
    records: [makeSale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1 })],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reRingAdjustment', () => {
  it('proposes a fixed discount for the whole increase when today is higher', () => {
    expect(reRingAdjustment(9, 10.5)).toEqual({
      suggestedDiscount: { amount: 1.5 },
      customerOverpaid: null,
    });
  });

  it('records the difference as overpaid and proposes no discount when today is lower', () => {
    expect(reRingAdjustment(9, 7.25)).toEqual({ suggestedDiscount: null, customerOverpaid: 1.75 });
  });

  it('proposes nothing when the totals agree, also across float noise', () => {
    expect(reRingAdjustment(9, 9)).toEqual({ suggestedDiscount: null, customerOverpaid: null });
    expect(reRingAdjustment(0.1 + 0.2, 0.3)).toEqual({ suggestedDiscount: null, customerOverpaid: null });
    expect(reRingAdjustment(9, 9.004)).toEqual({ suggestedDiscount: null, customerOverpaid: null });
  });

  it('keeps two decimals', () => {
    expect(reRingAdjustment(19.99, 20.1).suggestedDiscount).toEqual({ amount: 0.11 });
  });
});

describe('completeReRing', () => {
  it('the re-ring audit row is retried and carries the new total', async () => {
    vi.useFakeTimers();
    try {
      // two failed attempts (the server swallowed its own failure: null id; then a transport error), then success
      rpc
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'down' } })
        .mockResolvedValueOnce({ data: 'audit-id', error: null });

      const res = completeReRing(marker, NEW_TAB, 7.25);
      expect(res.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(rpc).toHaveBeenCalledTimes(3);
      for (const call of rpc.mock.calls) {
        expect(call[1]).toMatchObject({
          p_action: 'offline_sale_resolved',
          p_after: { resolution: 'rering', linkedTabId: NEW_TAB, newTotal: 7.25, delta: 1.75 },
        });
      }
      expect(log.error).not.toHaveBeenCalled();

      // when every attempt fails the last word is an error in the log, and it stops at three
      rpc.mockClear();
      rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
      useOfflineSaleStore.setState({
        records: [makeSale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1 })],
      });
      completeReRing(marker, NEW_TAB, 7.25);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rpc).toHaveBeenCalledTimes(3);
      expect(log.error).toHaveBeenCalledWith(
        'offline_sale.rering.audit_failed',
        expect.objectContaining({ saleId: SALE })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the record as re-rung and linked, then writes the audit row', async () => {
    const order: string[] = [];
    rpc.mockImplementation(() => {
      order.push(`audit:${only().status}`);
      return Promise.resolve({ data: 'audit-id', error: null });
    });

    const res = completeReRing(marker, NEW_TAB, 7.25);

    expect(res.ok).toBe(true);
    expect(only()).toMatchObject({
      status: 'resolved',
      resolution: 'rering',
      resolvedBy: MANAGER,
      linkedTabId: NEW_TAB,
      customerOverpaid: 1.75,
    });
    // the transition is stored before the audit is attempted
    expect(order).toEqual(['audit:resolved']);
    const [name, args] = rpc.mock.calls[0] ?? [];
    expect(name).toBe('record_audit');
    expect(args).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_entity_id: NEW_TAB,
      p_source: 'client',
      p_after: {
        resolution: 'rering',
        by: MANAGER,
        linkedTabId: NEW_TAB,
        delta: 1.75,
        approvalId: APPROVAL,
      },
    });
  });

  it('completion returns before the audit call settles', async () => {
    rpc.mockReturnValue(new Promise(() => undefined));
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(true);
    expect(only().status).toBe('resolved');
  });

  it('leaves customerOverpaid unset when the new sale cost the same or more', async () => {
    completeReRing(marker, NEW_TAB, 9);
    expect(only().customerOverpaid).toBeUndefined();
  });

  it('is safe to run twice for the same new sale', async () => {
    completeReRing(marker, NEW_TAB, 9);
    rpc.mockClear();
    const again = completeReRing(marker, NEW_TAB, 9);
    expect(again.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('completing an already completed re-ring is a no-op', async () => {
    completeReRing(marker, NEW_TAB, 9);
    const before = only();
    rpc.mockClear();
    const again = completeReRing(marker, NEW_TAB, 8);
    expect(again).toEqual({ ok: true, data: before });
    expect(only()).toEqual(before);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('still succeeds when the audit row cannot be written, and says so in the log', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(true);
    expect(only().status).toBe('resolved');
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'offline_sale.rering.audit_failed',
        expect.objectContaining({ saleId: SALE, tabId: NEW_TAB })
      );
      // the error is logged only after the retries (three tries a second apart)
    }, { timeout: 5_000 });
  });

  it('reports the new sale and does not throw when the change cannot be stored', async () => {
    const write = failWrites();

    const res = completeReRing(marker, NEW_TAB, 9);

    expect(res.ok).toBe(false);
    expect(write.mock.calls.length).toBeGreaterThan(1); // retried
    expect(res.ok ? '' : res.error.message).toContain(NEW_TAB.slice(0, 8));
    expect(only().status).toBe('needs_review');
    expect(log.error).toHaveBeenCalled();
    expect(unlinkedReRingTab(SALE)).toBe(NEW_TAB);

    // the link is still audited, unlinked, so /audit holds it after a restart
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalled();
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_entity_id: NEW_TAB,
      p_after: {
        resolution: 'rering',
        linked: false,
        by: MANAGER,
        linkedTabId: NEW_TAB,
        delta: 0,
        approvalId: APPROVAL,
      },
    });

    // storage works again: the same call links it and forgets the failure
    write.mockRestore();
    const retry = completeReRing(marker, NEW_TAB, 9);
    expect(retry.ok).toBe(true);
    expect(unlinkedReRingTab(SALE)).toBeUndefined();
  });

  it('does not wait for the unlinked audit either', async () => {
    failWrites();
    rpc.mockReturnValue(new Promise(() => undefined));
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(false);
  });

  it('refuses, naming the new sale, when the record is no longer waiting for review', async () => {
    useOfflineSaleStore.setState({ records: [makeSale({ status: 'queued' })] });
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain(NEW_TAB.slice(0, 8));
  });

  it('refuses, naming the new sale, when the record is gone', async () => {
    useOfflineSaleStore.setState({ records: [] });
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain(NEW_TAB.slice(0, 8));
  });

  it('a second tab refused linkage writes an audit row', async () => {
    const FIRST_TAB = '99999999-9999-4999-8999-999999999999';
    useOfflineSaleStore.setState({
      records: [
        makeSale({ status: 'resolved', resolution: 'rering', resolvedBy: MANAGER, linkedTabId: FIRST_TAB }),
      ],
    });
    const before = only();

    const res = completeReRing(marker, NEW_TAB, 9);

    expect(res.ok).toBe(false);
    expect(only()).toBe(before);
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledTimes(1);
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_entity_id: NEW_TAB,
      p_after: { linked: false, tabId: NEW_TAB, existingLinkedTabId: FIRST_TAB },
    });
  });

  it('a failing audit never changes the record of a refused second tab', async () => {
    useOfflineSaleStore.setState({
      records: [makeSale({ status: 'resolved', resolution: 'written_off', resolvedBy: MANAGER })],
    });
    const before = only();
    rpc.mockRejectedValue(new Error('down'));
    const res = completeReRing(marker, NEW_TAB, 9);
    expect(res.ok).toBe(false);
    expect(only()).toBe(before);
  });
});

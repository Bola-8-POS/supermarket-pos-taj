/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { act, render, waitFor } from '@testing-library/react';
import type * as EntityModule from '@entities/offline-sale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const online = { value: true };

// The real SHA-256 digest finishes on a thread no fake clock drives, so every test but the tamper
// ones swaps `verifySaleIntegrity` for a stand-in that resolves through microtasks.
const integrity = vi.hoisted(() => ({
  impl: undefined as undefined | ((record: unknown) => Promise<boolean>),
}));
vi.mock('@entities/offline-sale', async importOriginal => {
  const actual = await importOriginal<typeof EntityModule>();
  return {
    ...actual,
    verifySaleIntegrity: (record: Parameters<typeof actual.verifySaleIntegrity>[0]) =>
      integrity.impl ? integrity.impl(record) : actual.verifySaleIntegrity(record),
  };
});
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => online.value,
}));

const instance = vi.hoisted(() => ({ role: 'primary' as 'unknown' | 'primary' | 'secondary' }));
vi.mock('@shared/lib/instance-lock', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInstanceRole: () => instance.role,
  getInstanceRole: () => instance.role,
}));

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

let evaluation: { state: string; reason?: string } = { state: 'active' };
vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentLicenseEvaluation: () => evaluation,
}));

const rpc = vi.fn<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>>();
const getSession = vi.fn<() => Promise<{ data: { session: { user: { id: string } } | null } }>>();
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => getSession() },
  },
  getCachedAccessToken: () => 'test-token',
}));

const callProcess = vi.fn<
  (request: ProcessDirectSaleRequest, opts?: { offlineReplay?: boolean }) => Promise<Answer>
>();
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callProcessDirectSale: (request: ProcessDirectSaleRequest, opts?: { offlineReplay?: boolean }) =>
    callProcess(request, opts),
}));

import { useLockStateStore } from '@shared/lib/lock-state-store';
import { useOfflineSaleStore, computeSaleIntegrity } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import {
  catchToAppError,
  mapProcessPaymentEdgeError,
  type ProcessDirectSaleRequest,
  type ProcessDirectSaleSuccess,
  type ReceiptData,
} from '@shared/lib/edge-function-contracts';
import {
  REPLAY_REQUEST_TIMEOUT_MS,
  REPLAY_SESSION_TIMEOUT_MS,
  UNREACHABLE_RETRY_MS,
} from '@shared/lib/offline-retry';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { err, ok, type Result } from '@shared/lib/result';
import { licenseGuardedFetch } from '@shared/lib/supabase';
import type { AppError } from '@shared/lib/supabase-contracts';
import { OfflineSaleReplayer } from './OfflineSaleReplayer';

type Answer = Result<ProcessDirectSaleSuccess, AppError>;

const STAFF = '22222222-2222-4222-8222-222222222222';
const OTHER_STAFF = '99999999-9999-4999-8999-999999999999';
const TAB = '66666666-6666-4666-8666-666666666666';
const T0 = Date.parse('2026-10-09T10:00:00.000Z');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const records = () => useOfflineSaleStore.getState().records;
const byId = (n: number) => records().find(r => r.id === uuid(n));

/** A queued cash sale for $9.00, `n` minutes after T0, with a valid integrity digest. */
async function sale(n: number, overrides: Partial<OfflineSale> = {}): Promise<OfflineSale> {
  const base = makeSale({
    id: uuid(n),
    soldAt: new Date(T0 + n * 60_000).toISOString(),
    receiptNumber: `P-${String(n).padStart(6, '0')}`,
    ...overrides,
  });
  const request = { ...base.request, idempotencyKey: `direct_sale_${n}`, ...overrides.request };
  const withKey = { ...base, request };
  return {
    ...withKey,
    integrity:
      overrides.integrity ??
      (await computeSaleIntegrity(request, withKey.soldAt, withKey.receiptNumber)),
  };
}
const seed = async (...sales: Promise<OfflineSale>[]) =>
  useOfflineSaleStore.setState({ records: await Promise.all(sales) });

const okAnswer = (total = 9, extra: Partial<ProcessDirectSaleSuccess> = {}): Answer =>
  ok({
    tabId: TAB,
    receiptData: { total, receiptNumber: 'ABCDEF12' } as unknown as ReceiptData,
    ...extra,
  } as ProcessDirectSaleSuccess);
// What callProcessDirectSale returns for an edge failure envelope: mapped error + `details`.
const failAnswer = (code: string, message: string): Answer =>
  err({ ...mapProcessPaymentEdgeError(code, message), details: `${code}: ${message}` });
const outcomeUnknown: Answer = err({ code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'lost' });

const signIn = (id = STAFF) =>
  useStaffStore.setState({ isAuthenticated: true, currentStaff: { id } as Staff });

// Everything under test settles through microtasks (stubbed digest, mocked network), so draining
// them is deterministic; no wall-clock waiting anywhere.
const drain = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve();
};
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
    await vi.advanceTimersByTimeAsync(0);
    await drain();
  });

const mount = () => render(<OfflineSaleReplayer />);
const flush = () => act(drain);
const auditCalls = () => rpc.mock.calls.filter(([name]) => name === 'record_audit');
const failWrites = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  online.value = true;
  instance.role = 'primary';
  evaluation = { state: 'active' };
  useOfflineSaleStore.setState({ records: [] });
  useLockStateStore.setState({ locked: false });
  signIn();
  integrity.impl = () => Promise.resolve(true);
  rpc.mockResolvedValue({ data: 'audit-id', error: null });
  getSession.mockResolvedValue({ data: { session: { user: { id: STAFF } } } });
  callProcess.mockResolvedValue(okAnswer());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
  useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
});

describe('OfflineSaleReplayer', () => {
  it('replays FIFO one at a time', async () => {
    await seed(sale(3), sale(1), sale(2));
    const pending: Array<(a: Answer) => void> = [];
    callProcess.mockImplementation(() => new Promise<Answer>(resolve => pending.push(resolve)));

    mount();
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(callProcess.mock.calls[0]?.[0].idempotencyKey).toBe('direct_sale_1');

    await act(async () => {
      pending[0]?.(okAnswer());
    });
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(2);
    expect(callProcess.mock.calls[1]?.[0].idempotencyKey).toBe('direct_sale_2');

    await act(async () => {
      pending[1]?.(okAnswer());
    });
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(3);
    expect(callProcess.mock.calls[2]?.[0].idempotencyKey).toBe('direct_sale_3');

    await act(async () => {
      pending[2]?.(okAnswer());
    });
    await flush();
    expect(records().map(r => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  });

  it('a second trigger during a pass does nothing', async () => {
    await seed(sale(1));
    let release: (a: Answer) => void = () => undefined;
    callProcess.mockImplementation(() => new Promise<Answer>(resolve => (release = resolve)));

    const view = mount();
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);

    // reconnect twice while the first request is still in flight
    online.value = false;
    view.rerender(<OfflineSaleReplayer />);
    online.value = true;
    view.rerender(<OfflineSaleReplayer />);
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(okAnswer());
    });
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('same key on every attempt', async () => {
    await seed(sale(1));
    callProcess.mockResolvedValueOnce(outcomeUnknown);
    const view = mount();
    await flush();
    expect(byId(1)?.status).toBe('queued');

    online.value = false;
    view.rerender(<OfflineSaleReplayer />);
    online.value = true;
    view.rerender(<OfflineSaleReplayer />);
    await flush();

    expect(callProcess).toHaveBeenCalledTimes(2);
    const keys = callProcess.mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys).toEqual(['direct_sale_1', 'direct_sale_1']);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('idempotent true is confirmed, not a new sale', async () => {
    await seed(sale(1));
    callProcess.mockResolvedValue(okAnswer(9, { idempotent: true }));
    mount();
    await flush();

    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)).toMatchObject({ status: 'confirmed', tabId: TAB });
    expect(byId(1)?.confirmedReceipt).toMatchObject({ receiptNumber: 'ABCDEF12' });
  });

  it('unreachable keeps queued and does not count', async () => {
    await seed(sale(1));
    callProcess.mockResolvedValue(outcomeUnknown);
    mount();
    await flush();

    const record = byId(1);
    expect(record).toMatchObject({ status: 'queued', attempts: 0 });
    expect(Date.parse(record?.nextAttemptAt ?? '')).toBeGreaterThan(Date.now() + UNREACHABLE_RETRY_MS - 5_000);
    expect(auditCalls()).toHaveLength(0);
  });

  it('a reconnect retries a held sale without waiting for the timer', async () => {
    await seed(sale(1));
    callProcess.mockResolvedValueOnce(outcomeUnknown);
    const view = mount();
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(Date.parse(byId(1)?.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());

    online.value = false;
    view.rerender(<OfflineSaleReplayer />);
    online.value = true;
    view.rerender(<OfflineSaleReplayer />);
    await flush();

    expect(callProcess).toHaveBeenCalledTimes(2);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a held sale is retried when its timer arrives, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    callProcess.mockResolvedValueOnce(outcomeUnknown);
    mount();
    await advance(50);
    expect(callProcess).toHaveBeenCalledTimes(1);

    await advance(UNREACHABLE_RETRY_MS - 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);

    await advance(2_000);
    expect(callProcess).toHaveBeenCalledTimes(2);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('PRICE_MISMATCH goes to needs_review once and is never retried automatically', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    callProcess.mockResolvedValue(failAnswer('PRICE_MISMATCH', 'Price mismatch for item 1'));
    const view = mount();
    await advance(50);

    expect(byId(1)).toMatchObject({ status: 'needs_review', lastCode: 'PRICE_MISMATCH' });
    expect(callProcess).toHaveBeenCalledTimes(1);

    online.value = false;
    view.rerender(<OfflineSaleReplayer />);
    online.value = true;
    view.rerender(<OfflineSaleReplayer />);
    await advance(10 * 60_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('needs_review');

    expect(auditCalls()).toHaveLength(1);
    const [, args] = auditCalls()[0] ?? [];
    expect(args).toMatchObject({
      p_action: 'offline_sale_needs_review',
      p_entity_type: 'payment',
      p_entity_id: null,
      p_before: {
        receiptNumber: 'P-000001',
        total: 9,
        soldAt: new Date(T0 + 60_000).toISOString(),
        terminalId: 'POS-1',
        staffId: STAFF,
        code: 'PRICE_MISMATCH',
      },
      p_after: { code: 'PRICE_MISMATCH' },
    });
  });

  it('a success with a different total is not confirmed', async () => {
    await seed(sale(1));
    callProcess.mockResolvedValue(okAnswer(9.5));
    mount();
    await flush();

    expect(byId(1)).toMatchObject({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH' });
    expect(byId(1)?.lastMessage).toContain(TAB);
    expect(byId(1)?.tabId).toBe(TAB); // the server's sale stays on the record
    expect(log.error).toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]?.[1]).toMatchObject({ p_entity_id: TAB });
  });

  it('counted failures end in needs_review UNKNOWN at the attempt limit', async () => {
    await seed(sale(1, { attempts: 4 }));
    callProcess.mockResolvedValue(failAnswer('DIRECT_SALE_FAILED', 'duplicate key value'));
    mount();
    await flush();

    expect(byId(1)).toMatchObject({ status: 'needs_review', lastCode: 'UNKNOWN', attempts: 5 });
    expect(auditCalls()).toHaveLength(1);
  });

  it('a sale confirmed after a counted failure writes a resolved audit row', async () => {
    await seed(sale(1, { attempts: 2 }));
    mount();
    await flush();

    expect(byId(1)?.status).toBe('confirmed');
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_entity_type: 'payment',
      p_entity_id: TAB,
      p_source: 'client',
      p_after: { resolution: 'confirmed_after_retry', attempts: 3 },
    });
  });

  it('a sale confirmed on the first attempt writes no audit row', async () => {
    await seed(sale(1));
    mount();
    await flush();
    expect(byId(1)?.status).toBe('confirmed');
    expect(auditCalls()).toHaveLength(0);
  });

  it('other cashier signed in leaves the record queued', async () => {
    await seed(sale(1));
    signIn(OTHER_STAFF);
    mount();
    await flush();

    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it("another cashier's record at the head does not stop the signed-in cashier's own sale", async () => {
    await seed(sale(1, { staffId: OTHER_STAFF }), sale(2));
    mount();
    await flush();

    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(callProcess.mock.calls[0]?.[0].idempotencyKey).toBe('direct_sale_2');
    expect(byId(1)?.status).toBe('queued');
    expect(byId(2)?.status).toBe('confirmed');
  });

  it('does nothing while signed out, and starts when a cashier signs in', async () => {
    await seed(sale(1));
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
    const view = mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();

    signIn();
    view.rerender(<OfflineSaleReplayer />);
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
  });

  it('a secondary instance does not replay', async () => {
    await seed(sale(1));
    // another copy of the app owns the store: sending from here could race it and double-send
    instance.role = 'secondary';
    const view = mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });

    // the first tick has not settled yet: not replaying either
    instance.role = 'unknown';
    view.rerender(<OfflineSaleReplayer />);
    await flush();
    expect(callProcess).not.toHaveBeenCalled();

    // the lock is granted: it starts
    instance.role = 'primary';
    view.rerender(<OfflineSaleReplayer />);
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('does nothing while the backend is unreachable', async () => {
    await seed(sale(1));
    online.value = false;
    mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)?.status).toBe('queued');
  });

  it('a cashier who signs out while the record is being checked does not send it', async () => {
    await seed(sale(1));
    integrity.impl = () => {
      useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
      return Promise.resolve(true);
    };
    mount();
    await flush();

    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('an expired session holds the sale and does not count', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    getSession.mockResolvedValue({ data: { session: null } });
    mount();
    await advance(50);

    expect(getSession).toHaveBeenCalled();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(auditCalls()).toHaveLength(0);

    // the token refreshes: the next pass sends it
    getSession.mockResolvedValue({ data: { session: { user: { id: STAFF } } } });
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a session read that never settles does not block the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    getSession.mockReturnValueOnce(new Promise(() => undefined));
    mount();
    await advance(50);
    expect(callProcess).not.toHaveBeenCalled();

    // the read is given up on: nothing was sent, nothing counted, the record is not stuck replaying
    await advance(REPLAY_SESSION_TIMEOUT_MS + 1_000);
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });

    // and the next pass (the 30 s retry) is free to run and send it
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a request that never settles is held and retried, not counted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    callProcess.mockReturnValueOnce(new Promise(() => undefined));
    mount();
    await advance(50);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('replaying');

    await advance(REPLAY_REQUEST_TIMEOUT_MS + 1_000);
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(Date.parse(byId(1)?.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());
    expect(auditCalls()).toHaveLength(0);

    // the same key goes out again and the server answers
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(2);
    expect(callProcess.mock.calls[1]?.[0].idempotencyKey).toBe('direct_sale_1');
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a late answer after a timeout is ignored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    let late: (a: Answer) => void = () => undefined;
    callProcess.mockReturnValueOnce(new Promise<Answer>(resolve => (late = resolve)));
    mount();
    await advance(50);
    await advance(REPLAY_REQUEST_TIMEOUT_MS + 1_000);
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });

    // the answer that finally arrives belongs to a request nobody waits for any more
    await act(async () => {
      late(failAnswer('PRICE_MISMATCH', 'late refusal'));
    });
    await flush();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(auditCalls()).toHaveLength(0);
  });

  it('a pass that picks nothing while a sale is queued re-arms itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const base = Date.now();
    await seed(sale(1, { attempts: 2, nextAttemptAt: new Date(base + 60_000).toISOString() }));
    mount();
    await advance(50);
    expect(callProcess).not.toHaveBeenCalled();

    // the wall clock was stepped back during the hold: the timer fires, the head is "not due" yet
    vi.setSystemTime(base - 3_600_000);
    await advance(60_000);
    expect(callProcess).not.toHaveBeenCalled();

    // the clock is right again; nothing but the pass's own re-arm can pick the sale up now
    vi.setSystemTime(base + 120_000);
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a rejected getSession is the same as no session', async () => {
    await seed(sale(1));
    getSession.mockRejectedValue(new Error('lock stolen'));
    mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('a session for another user does not send the sale', async () => {
    await seed(sale(1));
    getSession.mockResolvedValue({ data: { session: { user: { id: OTHER_STAFF } } } });
    mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('a record that stopped being queued while the session was checked is not sent', async () => {
    await seed(sale(1));
    getSession.mockImplementation(async () => {
      useOfflineSaleStore.setState({ records: [{ ...(byId(1) as OfflineSale), status: 'resolved' }] });
      return { data: { session: { user: { id: STAFF } } } };
    });
    mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)?.status).toBe('resolved');
  });

  it('a sale held for a session mismatch is retried once the session matches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    getSession.mockResolvedValue({ data: { session: { user: { id: OTHER_STAFF } } } });
    mount();
    await advance(50);

    expect(getSession).toHaveBeenCalled();
    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });

    getSession.mockResolvedValue({ data: { session: { user: { id: STAFF } } } });
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('an older queued sale that appears during the session check is sent first', async () => {
    const older = await sale(1);
    await seed(sale(2));
    getSession.mockImplementationOnce(() => {
      useOfflineSaleStore.setState({ records: [older, ...records()] });
      return Promise.resolve({ data: { session: { user: { id: STAFF } } } });
    });
    mount();
    await flush();

    expect(callProcess.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      'direct_sale_1',
      'direct_sale_2',
    ]);
    expect(records().map(r => r.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('a reconnect does not skip the backoff of a counted failure', async () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    await seed(sale(1, { attempts: 2, nextAttemptAt: later }));
    const view = mount();
    await flush();
    online.value = false;
    view.rerender(<OfflineSaleReplayer />);
    online.value = true;
    view.rerender(<OfflineSaleReplayer />);
    await flush();

    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 2, nextAttemptAt: later });
  });

  it('a manager retry is picked up without a reconnect', async () => {
    await seed(sale(1, { status: 'needs_review', attempts: 5, lastCode: 'UNKNOWN', lastMessage: 'x' }));
    mount();
    await flush();
    expect(callProcess).not.toHaveBeenCalled();

    await act(async () => {
      useOfflineSaleStore.getState().applyEvent(uuid(1), { type: 'retryRequested' });
    });
    await waitFor(() => {
      expect(byId(1)?.status).toBe('confirmed');
    });

    expect(callProcess).toHaveBeenCalledTimes(1);
  });

  it('a sale confirmed after a manager retry writes the closing audit row', async () => {
    await seed(sale(1, { attempts: 0, lastCode: 'PRICE_MISMATCH', lastMessage: 'x' }));
    mount();
    await flush();

    expect(byId(1)?.status).toBe('confirmed');
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_after: { resolution: 'confirmed_after_retry', attempts: 1 },
    });
  });

  it('client-controlled strings are truncated in the audit payload', async () => {
    integrity.impl = undefined; // the real digest
    const base = await sale(1);
    await seed(
      sale(1, {
        integrity: 'not-the-digest',
        receiptNumber: `P-${'9'.repeat(500)}`,
        soldAt: `${base.soldAt}${' '.repeat(300)}`,
      })
    );
    mount();
    await waitFor(() => {
      expect(auditCalls()).toHaveLength(1);
    });

    const [, args] = auditCalls()[0] ?? [];
    const before = (args as { p_before: { receiptNumber: string; soldAt: string } }).p_before;
    expect(before.receiptNumber).toHaveLength(64);
    expect(before.soldAt).toHaveLength(64);
  });

  it('an engaged idle lock does not stop replay', async () => {
    await seed(sale(1));
    useLockStateStore.setState({ locked: true });
    mount();
    await flush();
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  describe('licence', () => {
    const BASE = 'http://127.0.0.1:56321';
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));

    // The real guard in front of the stubbed request: the replayer's scope decides the outcome.
    beforeEach(() => {
      fetchMock.mockClear();
      vi.stubGlobal('fetch', fetchMock);
      callProcess.mockImplementation(async (_request, opts) => {
        try {
          await licenseGuardedFetch(
            `${BASE}/functions/v1/process-direct-sale`,
            { method: 'POST' },
            opts
          );
          return okAnswer();
        } catch (error) {
          return err(catchToAppError(error) ?? { code: 'UNKNOWN_ERROR', message: String(error) });
        }
      });
    });

    it('restricted terminal replays, hard locked terminal holds', async () => {
      evaluation = { state: 'restricted', reason: 'lease_expired' };
      await seed(sale(1));
      const view = mount();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(byId(1)?.status).toBe('confirmed');
      view.unmount();

      evaluation = { state: 'locked', reason: 'unlicensed' };
      fetchMock.mockClear();
      await seed(sale(2));
      mount();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(byId(2)).toMatchObject({ status: 'queued', attempts: 0 });
      expect(Date.parse(byId(2)?.nextAttemptAt ?? '')).toBeGreaterThan(Date.now());
      expect(auditCalls()).toHaveLength(0);
    });

    it('only the replay request is widened, an ordinary one stays refused', async () => {
      evaluation = { state: 'restricted', reason: 'lease_expired' };
      await seed(sale(1));
      mount();
      await flush();
      expect(byId(1)?.status).toBe('confirmed');
      expect(callProcess.mock.calls[0]?.[1]).toEqual({ offlineReplay: true });
      await expect(
        licenseGuardedFetch(`${BASE}/functions/v1/process-direct-sale`, { method: 'POST' })
      ).rejects.toThrow(/LICENSE_RESTRICTED/);
    });
  });

  it('tampered record is not sent', async () => {
    integrity.impl = undefined; // the real digest
    await seed(sale(1, { integrity: 'not-the-digest' }), sale(2));
    mount();
    await waitFor(() => {
      expect(byId(2)?.status).toBe('confirmed');
    });

    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(callProcess.mock.calls[0]?.[0].idempotencyKey).toBe('direct_sale_2');
    expect(byId(1)).toMatchObject({ status: 'needs_review', lastCode: 'TAMPERED' });
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_needs_review',
      p_before: { receiptNumber: 'P-000001', code: 'TAMPERED' },
    });
  });

  it.each([
    ['rejects', () => rpc.mockRejectedValue(new Error('audit down'))],
    ['returns an error', () => rpc.mockResolvedValue({ data: null, error: { message: 'rls' } })],
  ])('audit failure never changes the record status (the audit call %s)', async (_name, breakAudit) => {
    await seed(sale(1));
    callProcess.mockResolvedValue(failAnswer('PRICE_MISMATCH', 'Price mismatch'));
    breakAudit();
    mount();
    await flush();

    expect(auditCalls()).toHaveLength(1);
    expect(byId(1)).toMatchObject({ status: 'needs_review', lastCode: 'PRICE_MISMATCH' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('a server answer whose write fails is applied again on the next pass without re-sending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    let writes: ReturnType<typeof failWrites> | undefined;
    callProcess.mockImplementation(async () => {
      writes = failWrites(); // replayStarted is already on disk; the answer cannot be stored
      return okAnswer();
    });
    mount();
    await advance(50);

    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('replaying'); // memory rolled back, nothing claims confirmed
    expect(log.error).toHaveBeenCalled();

    writes?.mockRestore();
    await advance(UNREACHABLE_RETRY_MS + 1_000);

    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)).toMatchObject({ status: 'confirmed', tabId: TAB });
  });

  it('a failed replayStarted write sends nothing and is retried on a later pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await seed(sale(1));
    const writes = failWrites();
    mount();
    await advance(50);

    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)?.status).toBe('queued');
    expect(log.error).toHaveBeenCalled();

    writes.mockRestore();
    await advance(UNREACHABLE_RETRY_MS + 1_000);
    expect(callProcess).toHaveBeenCalledTimes(1);
    expect(byId(1)?.status).toBe('confirmed');
  });

  it('a request that throws is a counted failure on the same key', async () => {
    await seed(sale(1));
    callProcess.mockRejectedValue(new Error('boom'));
    mount();
    await flush();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 1, lastMessage: 'boom' });
  });

  it('does not run in the product peek window', async () => {
    await seed(sale(1));
    window.history.pushState({}, '', '/?window=peek');
    mount();
    await flush();

    expect(callProcess).not.toHaveBeenCalled();
    expect(byId(1)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(records()).toHaveLength(1);
  });
});

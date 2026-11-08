/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const online = vi.hoisted(() => ({ value: true }));
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isOnline: () => online.value,
}));

const instance = vi.hoisted(() => ({ role: 'primary' as 'unknown' | 'primary' | 'secondary' }));
vi.mock('@shared/lib/instance-lock', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInstanceRole: () => instance.role,
}));

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

type Reply = { data: unknown; error: unknown };
const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Reply>>());
// The client reads no table to decide anything (02c Task 4): any read fails the test that makes it.
const tableReads = vi.hoisted(() => vi.fn<(table: string) => void>());
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => {
      tableReads(table);
      throw new Error(`unexpected client read of ${table}`);
    },
  },
}));

const license = vi.hoisted(() => ({ state: 'active' as 'active' | 'restricted' | 'locked' }));
vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentLicenseEvaluation: () => ({ state: license.state }),
}));

// The real digest is covered in the entity; here it is a switch so a tampered record is one line.
const integrity = vi.hoisted(() => ({ intact: true }));
vi.mock('@entities/offline-sale', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifySaleIntegrity: () => Promise.resolve(integrity.intact),
}));

const receiptSettings = vi.hoisted(() => ({ value: undefined as unknown }));
// What re-ring prices from: the same four sources the checkout screen uses.
const catalog = vi.hoisted(() => ({
  products: undefined as unknown,
  promotions: undefined as unknown,
  settings: undefined as unknown,
  alerts: undefined as unknown,
}));
vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: receiptSettings.value }),
  useSettings: () => ({ data: catalog.settings }),
}));
vi.mock('@entities/product', () => ({ useProducts: () => ({ data: catalog.products }) }));
vi.mock('@entities/inventory', () => ({ useNearExpiryPricingDates: () => ({ data: catalog.alerts }) }));
vi.mock('@entities/promotion', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePromotions: () => ({ data: catalog.promotions }),
}));

const printReceipt = vi.hoisted(() => vi.fn());
vi.mock('@shared/lib/pos-printer', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  printReceipt: (...args: unknown[]) => printReceipt(...args),
}));

import {
  completeReRing,
  reRingAdjustment,
  unlinkedReRingTab,
  useOfflineSaleStore,
} from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Product, Promotion, Staff } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { ok } from '@shared/lib/result';
import {
  fillReRingCart,
  OFFLINE_SALE_APPROVAL_ACTION,
  resetResolveStateForTests,
  useResolveOfflineSale,
  type ManagerApprovalTicket,
} from './useResolveOfflineSale';

const CASHIER = '22222222-2222-4222-8222-222222222222';
const OTHER_CASHIER = '99999999-9999-4999-8999-999999999999';
const MANAGER = '77777777-7777-4777-8777-777777777777';
const TAB = '66666666-6666-4666-8666-666666666666';
let approvalSeq = 0;
// An approval id is single use inside the model, so every ticket gets its own.
const nextApproval = () => `5f1e2d3c-4b5a-4c6d-8e7f-${String(++approvalSeq).padStart(12, '0')}`;
const REASON = 'Customer left, cash recorded by hand';

const CATEGORY = '66666666-6666-4666-8666-666666666666';
const PRODUCT: Product = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice 1kg',
  categoryId: CATEGORY,
  category: {
    id: CATEGORY,
    name: 'Rice',
    color: '#aabbcc',
    sortOrder: 0,
    happyHourStart: null,
    happyHourEnd: null,
    routing: 'NONE',
    comboEligible: true,
    createdAt: new Date(),
  },
  basePrice: 4.5,
  happyHourPrice: null,
  imageUrl: null,
  photoPath: null,
  isActive: true,
  soldByWeight: false,
  sku: null,
  stock_threshold: null,
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: false,
  isCombo: false,
  modifiers: [],
};
const SETTINGS = {
  nearExpiry: { discountPercent: 15, thresholdDays: 14 },
  general: { timezone: 'America/Mexico_City' },
};
const withPrice = (basePrice: number): Product => ({ ...PRODUCT, basePrice });
const cart = () => useCartStore.getState();
const markerOf = () => {
  const marker = useCartStore.getState().reRing;
  if (!marker) throw new Error('no re-ring marker');
  return marker;
};
const cartTotal = () => cart().items.reduce((sum, i) => sum + i.lineTotal, 0);

const records = () => useOfflineSaleStore.getState().records;
const only = (): OfflineSale => {
  const [first] = records();
  if (!first) throw new Error('no record');
  return first;
};
const auditCalls = () => rpc.mock.calls.filter(([name]) => name === 'record_audit');

const resolveCalls = () => rpc.mock.calls.filter(([name]) => name === 'resolve_offline_sale');
const resolveArgs = (i = 0) => (resolveCalls()[i]?.[1] ?? {}) as Record<string, unknown>;
const AUDIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const answer = (outcome: string, extra: Record<string, unknown> = {}): Reply & { status: number } => ({
  data: { ok: true, outcome, approverId: MANAGER, auditId: AUDIT, idempotent: false, ...extra },
  error: null,
  status: 200,
});
const refused = (code: string): Reply & { status: number } => ({
  data: { ok: false, code },
  error: null,
  status: 200,
});
const failure = (error: Record<string, unknown>, status: number): Reply & { status: number } => ({
  data: null,
  error,
  status,
});

const seed = (...sales: OfflineSale[]) => useOfflineSaleStore.setState({ records: sales });
const review = (overrides: Partial<OfflineSale> = {}) =>
  makeSale({ status: 'needs_review', lastCode: 'CAJA_CLOSED', attempts: 1, ...overrides });

const signIn = (id: string, role: Staff['role']) =>
  useStaffStore.setState({ isAuthenticated: true, currentStaff: { id, role } as Staff });

const ticket = (overrides: Partial<ManagerApprovalTicket> = {}): ManagerApprovalTicket => ({
  approvalId: nextApproval(),
  action: OFFLINE_SALE_APPROVAL_ACTION,
  approver: { id: MANAGER },
  ...overrides,
});

/** Retry belongs to the cashier who rang the sale: run `fn` signed in as them, then sign the manager back in. */
const asSeller = <T>(fn: () => T): T => {
  signIn(CASHIER, 'cashier');
  try {
    return fn();
  } finally {
    signIn(MANAGER, 'manager');
  }
};

const mount = () => renderHook(() => useResolveOfflineSale()).result.current;

const failWrites = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // clearAllMocks leaves queued mockResolvedValueOnce answers behind: drain them, then re-arm the defaults below
  rpc.mockReset();
  printReceipt.mockReset();
  resetResolveStateForTests();
  online.value = true;
  instance.role = 'primary';
  integrity.intact = true;
  receiptSettings.value = undefined;
  catalog.products = [PRODUCT];
  catalog.promotions = [];
  catalog.settings = SETTINGS;
  catalog.alerts = [];
  useCartStore.setState({
    items: [],
    heldCart: null,
    comboResult: null,
    pendingIdempotencyKey: null,
    pendingIdempotencyFingerprint: null,
    reRing: null,
  });
  useOfflineSaleStore.setState({ records: [] });
  signIn(MANAGER, 'manager');
  // Each intent's own happy answer; a test queues another with mockResolvedValueOnce.
  rpc.mockImplementation((name, args) => {
    if (name !== 'resolve_offline_sale') return Promise.resolve({ data: 'audit-id', error: null });
    const intent = (args as { p_intent?: string } | undefined)?.p_intent;
    const outcome = intent === 'rering' ? 'proceed' : intent === 'review' ? 'moved_to_review' : 'written_off';
    return Promise.resolve(answer(outcome));
  });
  license.state = 'active';
  printReceipt.mockResolvedValue(ok({ jobId: 'job-1' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
});

describe('a secondary instance', () => {
  it('a secondary instance refuses resolution actions', async () => {
    const queued = makeSale({
      id: '88888888-8888-4888-8888-888888888888',
      staffId: OTHER_CASHIER,
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
    });
    seed(review(), queued);
    const { retry, writeOff, moveToReview, reRing } = mount();
    const [reviewed] = records();
    const id = reviewed?.id ?? '';
    const before = JSON.stringify(records());
    const used = ticket();

    // another copy of the app owns the store: a write from here could be erased, or erase theirs
    instance.role = 'secondary';
    const refusals = [
      retry(id),
      await writeOff(id, REASON, used),
      await moveToReview(queued.id, used),
      await reRing(id, used),
    ];
    for (const res of refusals) {
      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(!res.ok && res.error.message).toMatch(/another window/i);
    }
    expect(JSON.stringify(records())).toBe(before);
    expect(tableReads).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
    expect(useCartStore.getState().items).toHaveLength(0);

    // nothing was spent: the same approval works once this copy is the primary one
    instance.role = 'primary';
    expect(await writeOff(id, REASON, used)).toMatchObject({ ok: true, data: { kind: 'written_off' } });
  });
});

describe('write off', () => {
  it('write off needs a reason of at least 10 characters and a manager approval', async () => {
    seed(review());
    const { writeOff } = mount();
    const id = only().id;

    const refusals: Array<[string, Promise<{ ok: boolean; error?: { code: string } }>, string]> = [
      ['short reason', writeOff(id, 'too short', ticket()), 'VALIDATION_ERROR'],
      ['padding only', writeOff(id, '   short    ', ticket()), 'VALIDATION_ERROR'],
      ['no ticket', writeOff(id, REASON, undefined), 'AUTH_FORBIDDEN'],
      [
        'ticket for another action',
        writeOff(id, REASON, ticket({ action: 'process_refund' })),
        'AUTH_FORBIDDEN',
      ],
      [
        'a discount approval is not a resolution approval',
        writeOff(id, REASON, ticket({ action: 'apply_custom_discount' })),
        'AUTH_FORBIDDEN',
      ],
      ['ticket without an id', writeOff(id, REASON, ticket({ approvalId: '' })), 'AUTH_FORBIDDEN'],
      [
        'approver without a valid staff id',
        writeOff(id, REASON, ticket({ approver: { id: 'nope' } })),
        'AUTH_FORBIDDEN',
      ],
    ];
    for (const [label, pending, code] of refusals) {
      const res = await pending;
      expect(res.ok, label).toBe(false);
      expect(res.error?.code, label).toBe(code);
    }
    expect(only().status).toBe('needs_review');
    expect(auditCalls()).toHaveLength(0);
    expect(tableReads).not.toHaveBeenCalled();

    const done = await writeOff(id, `  ${REASON}  `, ticket());
    expect(done.ok).toBe(true);
    expect(only()).toMatchObject({
      status: 'resolved',
      resolution: 'written_off',
      resolvedBy: MANAGER,
    });
    expect(only().resolvedAt).toBeDefined();
  });

  it('a cashier cannot write off or re-ring', async () => {
    signIn(CASHIER, 'cashier');
    seed(review(), makeSale({ id: '88888888-8888-4888-8888-888888888888', staffId: OTHER_CASHIER }));
    const { writeOff, moveToReview, reRing } = mount();
    const [reviewed, queued] = records();

    for (const bad of [undefined, ticket({ approver: { id: CASHIER } })]) {
      // a ticket naming a cashier approver is the server's to refuse: it checks the approver's role
      if (bad) for (let n = 0; n < 3; n += 1) rpc.mockResolvedValueOnce(refused('INVALID_APPROVAL'));
      const w = await writeOff(reviewed?.id ?? '', REASON, bad);
      expect(w).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
      const m = await moveToReview(queued?.id ?? '', bad);
      expect(m).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
      const r = await reRing(reviewed?.id ?? '', bad);
      expect(r).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
    }
    expect(records().map(r => r.status)).toEqual(['needs_review', 'queued']);
    expect(auditCalls()).toHaveLength(0);
    expect(useCartStore.getState().items).toHaveLength(0);
    expect(useCartStore.getState().reRing).toBeNull();
    expect(tableReads).not.toHaveBeenCalled();
  });

  it('nothing is written off when nobody is signed in', async () => {
    seed(review());
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    expect(only().status).toBe('needs_review');
  });

  it('resolved records cannot be resolved again', async () => {
    seed(review());
    const { writeOff, retry } = mount();
    const id = only().id;
    expect((await writeOff(id, REASON, ticket())).ok).toBe(true);
    const resolvedAt = only().resolvedAt;
    rpc.mockClear();

    const again = await writeOff(id, REASON, ticket());
    expect(again).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(retry(id)).toMatchObject({ ok: false });
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'written_off', resolvedAt });
    expect(resolveCalls()).toHaveLength(0);

    // an already_recorded record is just as final
    seed(review());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const held = await writeOff(only().id, REASON, ticket());
    expect(held).toMatchObject({ ok: true, data: { kind: 'already_recorded' } });
    rpc.mockClear();
    expect(await writeOff(only().id, REASON, ticket())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'already_recorded' });
    expect(resolveCalls()).toHaveLength(0);
  });

  it('only a record that needs review can be written off', async () => {
    for (const status of ['queued', 'replaying', 'confirmed'] as const) {
      seed(makeSale({ status }));
      const res = await mount().writeOff(only().id, REASON, ticket());
      expect(res, status).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(only().status).toBe(status);
    }
    expect(auditCalls()).toHaveLength(0);
  });

  it('an unknown sale is not found', async () => {
    const res = await mount().writeOff('00000000-0000-4000-8000-000000000000', REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('the reason is clipped before it is sent', async () => {
    seed(review());
    await mount().writeOff(only().id, `${REASON} ${'x'.repeat(600)}`, ticket());
    expect(String(resolveArgs()['p_reason'])).toHaveLength(500);
  });
});

describe('write off through the server', () => {
  it('write-off calls resolve_offline_sale once with the sale id, key, attempt keys, goods, claim, reason and ticket, and never record_audit', async () => {
    seed(review({ reRingAttemptKeys: ['rering_key_1', 'rering_key_2'] }));
    const used = ticket();
    const res = await mount().writeOff(only().id, `  ${REASON}  `, used);

    expect(res).toMatchObject({ ok: true, data: { kind: 'written_off' } });
    expect(resolveCalls()).toHaveLength(1);
    expect(resolveArgs()).toEqual({
      p_intent: 'write_off',
      p_sale_id: only().id,
      p_idempotency_key: only().request.idempotencyKey,
      p_rering_keys: ['rering_key_1', 'rering_key_2'],
      p_lines: [{ product_id: PRODUCT.id, quantity: 2, modifier_ids: [], weight_grams: null }],
      p_seller_id: CASHIER,
      p_recorded_tab_id: null,
      p_claim: {
        total: 9,
        soldAt: only().soldAt,
        receiptNumber: only().receiptNumber,
        terminalId: 'POS-1',
        lastCode: 'CAJA_CLOSED',
        keyUntrusted: false,
      },
      p_reason: REASON,
      p_approval_id: used.approvalId,
      p_approver_id: MANAGER,
    });
    expect(auditCalls()).toHaveLength(0);
    expect(tableReads).not.toHaveBeenCalled();
  });

  it('a tampered record sends no key and claims keyUntrusted', async () => {
    seed(review({ reRingAttemptKeys: ['rering_key_1'] }));
    integrity.intact = false;
    const res = await mount().writeOff(only().id, REASON, ticket());

    expect(res.ok).toBe(true);
    expect(resolveArgs()['p_idempotency_key']).toBeNull();
    expect(resolveArgs()['p_rering_keys']).toEqual([]);
    expect(resolveArgs()['p_claim']).toMatchObject({ keyUntrusted: true });
  });

  it('the record becomes resolved only after the server answers written_off', async () => {
    seed(review());
    let release: (reply: Reply) => void = () => undefined;
    rpc.mockImplementationOnce(
      () =>
        new Promise<Reply>(resolve => {
          release = resolve;
        })
    );
    const pending = mount().writeOff(only().id, REASON, ticket());
    await vi.waitFor(() => {
      expect(resolveCalls()).toHaveLength(1);
    });
    expect(only().status).toBe('needs_review');

    release(answer('written_off'));
    expect(await pending).toMatchObject({ ok: true, data: { kind: 'written_off' } });
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'written_off', resolvedBy: MANAGER });
  });

  it('a missing function refuses with SERVER_UPDATE_REQUIRED, leaves the record in review and writes nothing', async () => {
    seed(review());
    const { writeOff } = mount();
    const reusable = ticket();
    const missing = [
      failure({ code: 'PGRST202', message: 'Could not find the function public.resolve_offline_sale' }, 404),
      failure({ code: '', message: 'Not Found' }, 404),
    ];
    for (const reply of missing) {
      rpc.mockClear();
      rpc.mockResolvedValueOnce(reply);
      const res = await writeOff(only().id, REASON, reusable);
      expect(res).toMatchObject({ ok: false, error: { code: 'SERVER_UPDATE_REQUIRED' } });
      expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverUpdateRequired'));
      expect(only().status).toBe('needs_review');
      expect(resolveCalls()).toHaveLength(1);
      expect(auditCalls()).toHaveLength(0);
    }
    // an answer nobody can parse is the same refusal, and the approval stays usable
    rpc.mockResolvedValueOnce({ data: { hello: 'world' }, error: null });
    expect(await writeOff(only().id, REASON, reusable)).toMatchObject({
      ok: false,
      error: { code: 'SERVER_UPDATE_REQUIRED' },
    });
    expect((await writeOff(only().id, REASON, reusable)).ok).toBe(true);
  });

  it('an unknown outcome is retried once with the same arguments and an idempotent answer resolves the record', async () => {
    seed(review());
    rpc
      .mockResolvedValueOnce(failure({ code: '', message: 'Failed to fetch' }, 0))
      .mockResolvedValueOnce(answer('written_off', { idempotent: true }));
    const res = await mount().writeOff(only().id, REASON, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'written_off' } });
    expect(resolveCalls()).toHaveLength(2);
    expect(resolveArgs(1)).toEqual(resolveArgs(0));
    expect(only().status).toBe('resolved');
    expect(auditCalls()).toHaveLength(0);

    // a second failure is final: the record stays in review
    seed(review());
    rpc.mockClear();
    rpc
      .mockResolvedValueOnce(failure({ code: 'XX000', message: 'boom' }, 503))
      .mockResolvedValueOnce(failure({ code: 'XX000', message: 'boom' }, 503));
    const failed = await mount().writeOff(only().id, REASON, ticket());
    expect(failed).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(resolveCalls()).toHaveLength(2);
    expect(only().status).toBe('needs_review');
  });

  it('a rejected approval shows the approval copy and leaves the record in review', async () => {
    seed(review());
    const { writeOff } = mount();
    for (const code of ['APPROVAL_REQUIRED', 'INVALID_APPROVAL', 'AMBIGUOUS_APPROVAL']) {
      rpc.mockResolvedValueOnce(refused(code));
      const res = await writeOff(only().id, REASON, ticket());
      expect(res, code).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
      expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.approvalRejected'));
      expect(only().status).toBe('needs_review');
    }
    expect(auditCalls()).toHaveLength(0);
  });

  it('already_recorded and already_rerung link the record to the server tab with no client audit row', async () => {
    const cases = [
      ['already_recorded', 'already_recorded'],
      ['already_rerung', 'rering'],
    ] as const;
    for (const [outcome, resolution] of cases) {
      seed(review());
      rpc.mockResolvedValueOnce(answer(outcome, { tabId: TAB }));
      const res = await mount().writeOff(only().id, REASON, ticket());
      expect(res, outcome).toMatchObject({ ok: true, data: { kind: outcome, tabId: TAB } });
      expect(only()).toMatchObject({ status: 'resolved', resolution, linkedTabId: TAB, resolvedBy: MANAGER });
    }
    expect(auditCalls()).toHaveLength(0);
  });

  it('a VALIDATION_ERROR answer maps to VALIDATION_ERROR', async () => {
    seed(review());
    rpc.mockResolvedValueOnce(refused('VALIDATION_ERROR'));
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    // a client-side refusal also ends here: only the server's answer makes one call and this copy
    expect(resolveCalls()).toHaveLength(1);
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
    expect(only().status).toBe('needs_review');
  });

  it('a raised AUTH_REQUIRED maps to AUTH_REQUIRED', async () => {
    seed(review());
    rpc.mockResolvedValueOnce(failure({ code: 'P0001', message: 'AUTH_REQUIRED: authentication required' }, 400));
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    expect(resolveCalls()).toHaveLength(1);
  });

  it('a raised FORBIDDEN maps to AUTH_FORBIDDEN', async () => {
    seed(review());
    rpc.mockResolvedValueOnce(failure({ code: 'P0001', message: 'FORBIDDEN: inactive or unknown staff member' }, 400));
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
    expect(resolveCalls()).toHaveLength(1);
  });

  it("a write-off call answered with another intent's stored outcome does not write the sale off", async () => {
    for (const outcome of ['proceed', 'moved_to_review']) {
      seed(review());
      rpc.mockResolvedValueOnce(answer(outcome, { idempotent: true }));
      const res = await mount().writeOff(only().id, REASON, ticket());
      expect(res, outcome).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
      expect(only().status, outcome).toBe('needs_review');
      expect(only().resolution, outcome).toBeUndefined();
    }
  });

  it('an unrecognised database error is the generic refusal, never SERVER_UPDATE_REQUIRED', async () => {
    seed(review());
    for (const code of ['22023', '22P02']) {
      rpc.mockClear();
      rpc.mockResolvedValueOnce(failure({ code, message: 'invalid input' }, 400));
      const res = await mount().writeOff(only().id, REASON, ticket());
      expect(res, code).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
      expect(resolveCalls(), code).toHaveLength(1);
      expect(only().status).toBe('needs_review');
    }
  });

  it('a raised SERVER_MISMATCH keeps the record in review and tells the manager to write the sale off', async () => {
    seed(review());
    rpc.mockResolvedValueOnce(failure({ code: 'P0001', message: 'SERVER_MISMATCH: goods' }, 400));
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverMismatch'));
    expect(only().status).toBe('needs_review');
  });
});

describe('single use and single flight', () => {
  it('an approval cannot be spent on two resolutions', async () => {
    const other = review({
      id: '12121212-1212-4212-8212-121212121212',
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_two' },
    });
    seed(review(), other);
    const { writeOff } = mount();
    const [first, second] = records();
    const spent = ticket();

    expect((await writeOff(first?.id ?? '', REASON, spent)).ok).toBe(true);
    const again = await writeOff(second?.id ?? '', REASON, spent);
    expect(again).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
    expect(records().map(r => r.status)).toEqual(['resolved', 'needs_review']);
    expect(resolveCalls()).toHaveLength(1);
  });

  it('an approval is not spent by an action the server did not answer', async () => {
    seed(review());
    const { writeOff } = mount();
    const reusable = ticket();
    rpc.mockResolvedValueOnce(failure({ code: 'PGRST202', message: 'missing' }, 404));
    expect((await writeOff(only().id, REASON, reusable)).ok).toBe(false);
    expect((await writeOff(only().id, REASON, reusable)).ok).toBe(true);
  });

  it('two concurrent write offs produce one audit row and one resolution', async () => {
    seed(review());
    const { writeOff } = mount();
    const id = only().id;
    const [a, b] = await Promise.all([
      writeOff(id, REASON, ticket()),
      writeOff(id, REASON, ticket()),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(resolveCalls()).toHaveLength(1);
    expect(tableReads).not.toHaveBeenCalled();
    expect(only().status).toBe('resolved');
  });

  it('one approval cannot be spent on two sales at the same time', async () => {
    const other = review({
      id: '12121212-1212-4212-8212-121212121212',
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_two' },
    });
    seed(review(), other);
    const { writeOff } = mount();
    const shared = ticket();
    const [a, b] = await Promise.all([
      writeOff(records()[0]?.id ?? '', REASON, shared),
      writeOff(records()[1]?.id ?? '', REASON, shared),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(resolveCalls()).toHaveLength(1);
  });

  it('a record that changes while the server is asked is not resolved, and a repeat is answered idempotently', async () => {
    seed(review());
    const id = only().id;
    rpc.mockImplementationOnce(() => {
      // same status, new object: any write to the record replaces it
      useOfflineSaleStore.setState(state => ({ records: state.records.map(r => ({ ...r })) }));
      return Promise.resolve(answer('written_off'));
    });
    const { writeOff } = mount();
    const res = await writeOff(id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(only().status).toBe('needs_review');
    expect(auditCalls()).toHaveLength(0);

    // the server already holds the row: the repeat (any ticket) is answered from it and now applies
    rpc.mockResolvedValueOnce(answer('written_off', { idempotent: true }));
    expect(await writeOff(id, REASON, ticket())).toMatchObject({ ok: true, data: { kind: 'written_off' } });
    expect(only().status).toBe('resolved');
  });
  it('retry is refused while a manager action is pending', async () => {
    seed(review());
    const { writeOff, retry } = mount();
    const id = only().id;
    let release: (reply: Reply) => void = () => undefined;
    rpc.mockImplementationOnce(
      () => new Promise<Reply>(resolve => {
          release = resolve;
        })
    );

    const pending = writeOff(id, REASON, ticket());
    await vi.waitFor(() => { expect(resolveCalls()).toHaveLength(1); });
    const whilePending = retry(id);
    const statusWhilePending = only().status;
    // always let the pending action finish, so a failure here cannot leave the sale locked for other tests
    release(answer('written_off'));
    expect(whilePending).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(statusWhilePending).toBe('needs_review');
    expect((await pending).ok).toBe(true);
    // the lock is released afterwards
    expect(retry(id)).toMatchObject({ ok: false });
    seed(review());
    expect(asSeller(() => retry(id)).ok).toBe(true);
  });

  it('the lock is released when the action fails', async () => {
    seed(review());
    const { writeOff, retry } = mount();
    // an answered refusal (a lost answer would keep retry refused, covered below)
    rpc.mockResolvedValueOnce(refused('VALIDATION_ERROR'));
    expect((await writeOff(only().id, REASON, ticket())).ok).toBe(false);
    expect(asSeller(() => retry(only().id)).ok).toBe(true);
  });
});

describe('retry', () => {
  it('the selling cashier can still retry their own sale', () => {
    for (const role of ['cashier', 'manager', 'admin'] as const) {
      // whoever made the sale retries it, whatever their role
      signIn(MANAGER, role);
      seed(review({ staffId: MANAGER, attempts: 5, lastCode: 'UNKNOWN' }));
      const res = mount().retry(only().id);
      expect(res.ok, role).toBe(true);
      expect(only(), role).toMatchObject({ status: 'queued', attempts: 0 });
    }
    signIn(CASHIER, 'cashier');
    seed(review({ attempts: 5, lastCode: 'UNKNOWN' }));
    expect(mount().retry(only().id).ok).toBe(true);
    expect(auditCalls()).toHaveLength(0);
  });

  it('retry is refused when the signed-in staff did not make the sale', () => {
    for (const role of ['cashier', 'manager', 'admin'] as const) {
      signIn(OTHER_CASHIER, role);
      seed(review({ attempts: 5, lastCode: 'UNKNOWN' }));
      const res = mount().retry(only().id);
      expect(res, role).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
      expect(!res.ok && res.error.message, role).toMatch(/selling cashier|re-ring|write off/i);
      expect(only(), role).toMatchObject({ status: 'needs_review', attempts: 5 });
    }
  });

  it('retry needs a signed-in user and a record that needs review', () => {
    seed(review());
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
    expect(mount().retry(only().id)).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    signIn(CASHIER, 'cashier');
    seed(makeSale());
    expect(mount().retry(only().id)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mount().retry('00000000-0000-4000-8000-000000000000')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('retry is refused for a sale with a recorded re-ring attempt', () => {
    signIn(CASHIER, 'cashier');
    seed(review({ attempts: 2, reRingAttemptKeys: ['direct_sale_rr_1'] }));

    const res = mount().retry(only().id);

    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!res.ok && res.error.message).toMatch(/re-ring|write off/i);
    expect(only()).toMatchObject({ status: 'needs_review', attempts: 2 });
  });

  it('a retry whose write cannot be stored is an error and the record is unchanged', () => {
    seed(review({ attempts: 3 }));
    const { retry } = mount();
    signIn(CASHIER, 'cashier');
    failWrites();
    const res = retry(only().id);
    expect(res).toMatchObject({ ok: false, error: { code: 'UNKNOWN_ERROR' } });
    expect(only()).toMatchObject({ status: 'needs_review', attempts: 3 });
  });
});

describe('server pre-check', () => {
  it('write off is refused and the record marked already recorded when the server holds the sale', async () => {
    seed(review({ lastCode: 'SHIFT_NOT_OPEN' }));
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const res = await mount().writeOff(only().id, REASON, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'already_recorded', tabId: TAB } });
    expect(only()).toMatchObject({
      status: 'resolved',
      resolution: 'already_recorded',
      linkedTabId: TAB,
      resolvedBy: MANAGER,
    });
    // the lookup and the audit row are the server's; the client reads and writes nothing itself
    expect(tableReads).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });
  it('a record that carries a server tab is marked already recorded, never written off', async () => {
    seed(review({ tabId: TAB, lastCode: 'AMOUNT_MISMATCH' }));
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const res = await mount().writeOff(only().id, REASON, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'already_recorded', tabId: TAB } });
    expect(only()).toMatchObject({ resolution: 'already_recorded', linkedTabId: TAB });
    // the tab the record names goes to the server, which compares it with what it holds
    expect(resolveArgs()['p_recorded_tab_id']).toBe(TAB);
  });
  it('a SERVER_MISMATCH refuses re-ring and move-to-review with the mismatch copy', async () => {
    const queued = makeSale({
      id: '88888888-8888-4888-8888-888888888888',
      staffId: OTHER_CASHIER,
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
    });
    seed(review({ tabId: TAB }), queued);
    const { reRing, moveToReview } = mount();
    const [reviewed] = records();
    const spent = ticket();
    for (const kind of ['cashier', 'tab', 'goods', 'attempt', 'claimed']) {
      rpc.mockResolvedValueOnce(failure({ code: 'P0001', message: `SERVER_MISMATCH: ${kind}` }, 400));
      const r = await reRing(reviewed?.id ?? '', spent);
      expect(r, kind).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(!r.ok && r.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverMismatch'));
      rpc.mockResolvedValueOnce(failure({ code: 'P0001', message: `SERVER_MISMATCH: ${kind}` }, 400));
      const m = await moveToReview(queued.id, spent);
      expect(m, kind).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(!m.ok && m.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverMismatch'));
    }
    expect(resolveArgs()['p_recorded_tab_id']).toBe(TAB);
    expect(records().map(r => r.status)).toEqual(['needs_review', 'queued']);
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();
    expect(auditCalls()).toHaveLength(0);
    // the server rolled the spend back, so the same ticket is still good
    expect((await reRing(reviewed?.id ?? '', spent)).ok).toBe(true);
  });
  it('a session that cannot read payments still writes off, because the server does the lookup', async () => {
    seed(review());
    const { writeOff } = mount();
    const id = only().id;

    // a role whose close_tab was removed on /rbac, would read zero rows themselves
    signIn(CASHIER, 'cashier');
    expect((await writeOff(id, REASON, ticket())).ok).toBe(true);
    expect(tableReads).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(1);
  });
});

describe('a paid re-ring recorded on the sale (D13)', () => {
  const ATTEMPTS = ['direct_sale_rr_1', 'direct_sale_rr_2'];
  const linked = () => {
    expect(only()).toMatchObject({
      status: 'resolved',
      resolution: 'rering',
      linkedTabId: TAB,
      resolvedBy: MANAGER,
    });
  };

  it('re-ring answers already_recorded / already_rerung by linking the record and leaves the cart empty', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB }));
    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'already_rerung', tabId: TAB } });
    linked();
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();
    // the recorded attempt keys are what lets the server find the twin; the lookup and the audit row are its own
    expect(resolveArgs()).toMatchObject({ p_intent: 'rering', p_rering_keys: ATTEMPTS });
    expect(tableReads).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);

    seed(review());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const held = await mount().reRing(only().id, ticket());
    expect(held).toMatchObject({ ok: true, data: { kind: 'already_recorded', tabId: TAB } });
    expect(only()).toMatchObject({
      status: 'resolved',
      resolution: 'already_recorded',
      linkedTabId: TAB,
      resolvedBy: MANAGER,
    });
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();
    expect(auditCalls()).toHaveLength(0);
  });

  it('write-off is refused in favour of the link when a recorded attempt key was paid', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB }));

    const res = await mount().writeOff(only().id, REASON, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'already_rerung', tabId: TAB } });
    linked();
    expect(only().resolution).not.toBe('written_off');
    // the recorded attempt keys are what lets the server find the twin
    expect(resolveArgs()['p_rering_keys']).toEqual(ATTEMPTS);
  });
  it('a write-off that links to a paid re-ring records the shortfall the server reports, never an overpayment', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB, serverAmount: 8.5, amountShort: 0.5 }));

    await mount().writeOff(only().id, REASON, ticket());

    linked();
    expect(only().amountShort).toBe(0.5);
    expect(only().customerOverpaid).toBeUndefined();
  });

  it('a write-off linked to the original over a duplicate re-ring stores the re-ring tab', async () => {
    const DUP = '5e4d3c2b-1111-4222-8333-444455556666';
    seed(review());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB, serverAmount: 8.5, duplicateReringTabId: DUP }));
    await mount().writeOff(only().id, REASON, ticket());
    expect(only().resolution).toBe('already_recorded');
    expect(only().linkedTabId).toBe(TAB);
    expect(only().duplicateReringTabId).toBe(DUP);
  });

  it('a re-ring that links records the shortfall', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB, serverAmount: 8.5, amountShort: 0.5 }));
    await mount().reRing(only().id, ticket());
    linked();
    expect(only().amountShort).toBe(0.5);

    seed(review());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB, serverAmount: 8.5, amountShort: 0.5 }));
    await mount().reRing(only().id, ticket());
    expect(only().amountShort).toBe(0.5);
    expect(only().customerOverpaid).toBeUndefined();
  });

  it('a split sale that links records the shortfall too', async () => {
    const base = makeSale();
    seed(
      review({
        reRingAttemptKeys: ATTEMPTS,
        request: {
          ...base.request,
          legs: [
            { method: 'cash', amount: 4, tenderedAmount: 4 },
            { method: 'cash', amount: 5, tenderedAmount: 5 },
          ],
        },
      })
    );
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB, serverAmount: 8.5, amountShort: 0.5 }));

    await mount().writeOff(only().id, REASON, ticket());

    linked();
    expect(only().amountShort).toBe(0.5);
    expect(only().customerOverpaid).toBeUndefined();
  });

  it('a link answer without amountShort (an older server) links with no marker', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    rpc.mockResolvedValueOnce(answer('already_rerung', { tabId: TAB, serverAmount: 8.5 }));

    const res = await mount().writeOff(only().id, REASON, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'already_rerung', tabId: TAB } });
    linked();
    expect(only().amountShort).toBeUndefined();
    expect(only().customerOverpaid).toBeUndefined();
  });

  it('a record whose attempt keys were never paid is re-rung as before', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    catalog.products = [PRODUCT];
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'rering' } });
    expect(only().status).toBe('needs_review');
  });

  it('a tampered record is never auto-linked from an attempt key', async () => {
    seed(review({ reRingAttemptKeys: ATTEMPTS }));
    integrity.intact = false;

    const reRung = await mount().reRing(only().id, ticket());
    expect(reRung).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    // refused before the server is asked: nothing was spent
    expect(resolveCalls()).toHaveLength(0);
    const off = await mount().writeOff(only().id, REASON, ticket());

    // write-off stays possible, sends no keys and says the key is untrusted
    expect(off).toMatchObject({ ok: true, data: { kind: 'written_off' } });
    expect(only()).toMatchObject({ resolution: 'written_off' });
    expect(only().linkedTabId).toBeUndefined();
    expect(resolveArgs()).toMatchObject({ p_idempotency_key: null, p_rering_keys: [] });
    expect(resolveArgs()['p_claim']).toMatchObject({ keyUntrusted: true });
  });

  it("re-ring does not act on another intent's stored outcome", async () => {
    for (const outcome of ['written_off', 'moved_to_review']) {
      seed(review());
      rpc.mockResolvedValueOnce(answer(outcome, { idempotent: true }));
      const res = await mount().reRing(only().id, ticket());
      expect(res, outcome).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
      expect(only().status, outcome).toBe('needs_review');
      expect(cart().items, outcome).toHaveLength(0);
      expect(cart().reRing, outcome).toBeNull();
    }
  });
  it('an answer that links without a tab does not resolve the record', async () => {
    seed(review());
    rpc.mockResolvedValueOnce(answer('already_rerung'));
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
    expect(resolveCalls()).toHaveLength(1);
    expect(only().status).toBe('needs_review');
    expect(cart().items).toHaveLength(0);
  });
});

describe('audit', () => {
  it('audit row written for every manager action', async () => {
    const queued = makeSale({
      id: '88888888-8888-4888-8888-888888888888',
      staffId: OTHER_CASHIER,
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
    });
    seed(review(), queued);
    const { writeOff, moveToReview } = mount();
    const [reviewed] = records();

    await writeOff(reviewed?.id ?? '', REASON, ticket());
    await moveToReview(queued.id, ticket());

    // write-off and escalation are audited by the server (its own row, in the RPC); the client writes none
    expect(resolveCalls().map(([, args]) => (args as { p_intent: string }).p_intent)).toEqual(['write_off', 'review']);
    expect(auditCalls()).toHaveLength(0);
  });
  it('an unstorable write off is an error', async () => {
    seed(review());
    const { writeOff } = mount();
    const id = only().id;
    failWrites();
    const res = await writeOff(id, REASON, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'UNKNOWN_ERROR' } });
    expect(only().status).toBe('needs_review');
  });

  it('no action mutates the stored request', async () => {
    const withKey = (key: string) => ({ ...makeSale().request, idempotencyKey: key });
    const retried = review({ request: withKey('direct_sale_retried') });
    const escalated = makeSale({
      id: '88888888-8888-4888-8888-888888888888',
      staffId: OTHER_CASHIER,
      request: withKey('direct_sale_escalated'),
    });
    const lost = review({
      id: '12121212-1212-4212-8212-121212121212',
      request: withKey('direct_sale_lost'),
    });
    const written = review({
      id: '34343434-3434-4434-8434-343434343434',
      request: withKey('direct_sale_written'),
    });
    const before = new Map([retried, escalated, lost, written].map(r => [r.id, JSON.stringify(r.request)]));
    seed(retried, escalated, lost, written);
    const { retry, writeOff, moveToReview } = mount();

    asSeller(() => retry(retried.id));
    await moveToReview(escalated.id, ticket());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    await writeOff(lost.id, REASON, ticket());
    await writeOff(written.id, REASON, ticket());

    expect(records().map(r => r.status)).toEqual(['queued', 'needs_review', 'resolved', 'resolved']);
    expect(records().map(r => r.resolution)).toEqual([undefined, undefined, 'already_recorded', 'written_off']);
    for (const r of records()) expect(JSON.stringify(r.request), r.id).toBe(before.get(r.id));
  });
});

describe('move to review', () => {
  const absent = () =>
    makeSale({
      id: '88888888-8888-4888-8888-888888888888',
      staffId: OTHER_CASHIER,
      attempts: 2,
      request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
    });

  it('a manager can move a queued sale of an absent cashier to review', async () => {
    seed(absent());
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'moved_to_review' } });
    expect(only()).toMatchObject({
      status: 'needs_review',
      lastCode: 'ESCALATED',
      attempts: 2,
    });
    expect(resolveCalls()).toHaveLength(1);
    expect(resolveArgs()).toMatchObject({ p_intent: 'review', p_sale_id: only().id });
    expect(tableReads).not.toHaveBeenCalled();
    // the server wrote its own row; the client writes none
    expect(auditCalls()).toHaveLength(0);
  });

  it('move-to-review escalates only after moved_to_review', async () => {
    seed(absent());
    let release: (reply: Reply) => void = () => undefined;
    rpc.mockImplementationOnce(
      () =>
        new Promise<Reply>(resolve => {
          release = resolve;
        })
    );
    const pending = mount().moveToReview(only().id, ticket());
    await vi.waitFor(() => {
      expect(resolveCalls()).toHaveLength(1);
    });
    expect(only().status).toBe('queued');
    release(answer('moved_to_review'));
    expect((await pending).ok).toBe(true);
    expect(only().status).toBe('needs_review');

    // another intent's stored outcome moves nothing
    for (const outcome of ['proceed', 'written_off', 'already_rerung']) {
      seed(absent());
      rpc.mockResolvedValueOnce(answer(outcome, { idempotent: true, tabId: TAB }));
      const res = await mount().moveToReview(only().id, ticket());
      expect(res, outcome).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
      expect(only().status, outcome).toBe('queued');
    }
  });

  it("move to review is refused for the signed-in cashier's own queued sale", async () => {
    signIn(CASHIER, 'cashier');
    seed(makeSale());
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(only().status).toBe('queued');
    expect(resolveCalls()).toHaveLength(0);
  });

  const HELD_UNTIL = '2026-10-09T10:30:00.000Z';

  it("a manager can move the signed-in cashier's held sale to review", async () => {
    signIn(CASHIER, 'cashier');
    // held: the replayer could not get a counted answer and has the next attempt scheduled
    seed(makeSale({ attempts: 2, nextAttemptAt: HELD_UNTIL }));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'moved_to_review' } });
    expect(only()).toMatchObject({ status: 'needs_review', lastCode: 'ESCALATED', attempts: 2 });
    expect(resolveCalls()).toHaveLength(1);
  });

  it("the signed-in cashier's sale that is not held cannot be moved to review", async () => {
    signIn(CASHIER, 'cashier');
    // no scheduled retry: the replayer is about to send it, or is sending it
    seed(makeSale({ attempts: 0 }));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(only().status).toBe('queued');
    expect(resolveCalls()).toHaveLength(0);
  });

  it('a held own sale the server already holds is marked already recorded', async () => {
    signIn(CASHIER, 'cashier');
    seed(makeSale({ attempts: 2, nextAttemptAt: HELD_UNTIL }));
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'already_recorded', tabId: TAB } });
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB });
    expect(auditCalls()).toHaveLength(0);
  });

  it('move to review is refused for a sale that is not queued', async () => {
    for (const status of ['replaying', 'needs_review', 'confirmed', 'resolved'] as const) {
      seed({ ...absent(), status });
      const res = await mount().moveToReview(only().id, ticket());
      expect(res, status).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(only().status).toBe(status);
    }
    expect(resolveCalls()).toHaveLength(0);
  });

  it('a queued sale the server already holds is resolved as already recorded, not sent to review', async () => {
    seed(absent());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'already_recorded', tabId: TAB } });
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB });
    expect(auditCalls()).toHaveLength(0);
  });

  it('a cashier who signs in during the server check keeps their own sale', async () => {
    seed(absent());
    rpc.mockImplementationOnce(() => {
      signIn(OTHER_CASHIER, 'cashier');
      return Promise.resolve(answer('moved_to_review'));
    });
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(only().status).toBe('queued');
  });

  it('a failed server check leaves the queued sale where it is', async () => {
    seed(absent());
    rpc.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(only().status).toBe('queued');
  });

  it('a missing function refuses with SERVER_UPDATE_REQUIRED and leaves the sale queued', async () => {
    seed(absent());
    rpc.mockResolvedValueOnce(failure({ code: 'PGRST202', message: 'missing' }, 404));
    const res = await mount().moveToReview(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'SERVER_UPDATE_REQUIRED' } });
    expect(only().status).toBe('queued');
    expect(auditCalls()).toHaveLength(0);
  });
});

describe('offline', () => {
  it('manager actions are refused offline, retry is not', async () => {
    seed(
      review(),
      makeSale({
        id: '88888888-8888-4888-8888-888888888888',
        staffId: OTHER_CASHIER,
        request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
      })
    );
    const { writeOff, moveToReview, retry } = mount();
    const [reviewed, queued] = records();
    online.value = false;

    expect(await writeOff(reviewed?.id ?? '', REASON, ticket())).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_OFFLINE' },
    });
    expect(await moveToReview(queued?.id ?? '', ticket())).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_OFFLINE' },
    });
    expect(records().map(r => r.status)).toEqual(['needs_review', 'queued']);
    expect(tableReads).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);

    expect(asSeller(() => retry(reviewed?.id ?? '')).ok).toBe(true);
    expect(records()[0]?.status).toBe('queued');
  });
});

describe('print confirmed', () => {
  const server = { receiptNumber: 'ABCDEF12', tabId: TAB, total: 9 } as unknown as ReceiptData;

  it('print confirmed prints the stored server receipt and refuses a provisional one', async () => {
    seed(makeSale({ status: 'confirmed', tabId: TAB, confirmedReceipt: server }));
    const { printConfirmed } = mount();
    const id = only().id;

    const res = await printConfirmed(id);
    expect(res).toMatchObject({ ok: true, data: { jobId: 'job-1' } });
    expect(printReceipt).toHaveBeenCalledTimes(1);
    expect(printReceipt.mock.calls[0]?.[0]).toBe(server);

    printReceipt.mockClear();
    for (const status of ['queued', 'replaying', 'needs_review'] as const) {
      seed(makeSale({ status }));
      expect(await printConfirmed(only().id), status).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    // a stored receipt that somehow carries the provisional marker is never printed as confirmed
    seed(
      makeSale({
        status: 'confirmed',
        confirmedReceipt: { ...server, provisional: true } as unknown as ReceiptData,
      })
    );
    expect(await printConfirmed(only().id)).toMatchObject({ ok: false });
    expect(await printConfirmed('00000000-0000-4000-8000-000000000000')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it('a slimmed sale prints nothing and points to Payments', async () => {
    seed(makeSale({ status: 'confirmed', tabId: TAB, slimmed: true, lines: [] }));
    const res = await mount().printConfirmed(only().id);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Payments/) } });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it('printing needs a signed-in user', async () => {
    seed(makeSale({ status: 'confirmed', tabId: TAB, confirmedReceipt: server }));
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null });
    expect(await mount().printConfirmed(only().id)).toMatchObject({
      ok: false,
      error: { code: 'AUTH_REQUIRED' },
    });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it('a printer failure never returns raw text', async () => {
    seed(makeSale({ status: 'confirmed', tabId: TAB, confirmedReceipt: server }));
    printReceipt.mockResolvedValue({
      ok: false,
      error: { code: 'PRINT_BROKER_UNREACHABLE', message: 'RAW PRINTER TEXT: spooler 10.0.0.5 refused' },
    });
    const res = await mount().printConfirmed(only().id);
    expect(res).toMatchObject({ ok: false, error: { code: 'PRINT_BROKER_UNREACHABLE' } });
    if (res.ok) throw new Error('expected a refusal');
    expect(res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.printFailed'));
    expect(res.error.message).not.toContain('RAW PRINTER TEXT');
    // the printer's own words go to the log, not to the screen
    expect(JSON.stringify(log.warn.mock.calls)).toContain('RAW PRINTER TEXT');
  });

  it('a failed print is returned, not hidden', async () => {
    seed(makeSale({ status: 'confirmed', tabId: TAB, confirmedReceipt: server }));
    printReceipt.mockResolvedValue({ ok: false, error: { code: 'PRINT_BROKER_UNREACHABLE', message: 'x' } });
    expect(await mount().printConfirmed(only().id)).toMatchObject({
      ok: false,
      error: { code: 'PRINT_BROKER_UNREACHABLE' },
    });
  });
});

describe('re-ring', () => {
  // The server discounts the LINE price of a loose-weight line, so the re-ring must resolve the
  // promotion for the recorded weight: a dropped weight would put the per-kg 18.00 in as a line total.
  it('re-rings a promoted loose-weight line at its LINE price and keeps the promotion', async () => {
    const rice: Product = { ...PRODUCT, basePrice: 20, soldByWeight: true };
    const now = Date.now();
    const promotion: Promotion = {
      id: '99999999-9999-4999-8999-999999999999',
      name: '2 off rice',
      targets: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', promotionId: '99999999-9999-4999-8999-999999999999', productId: rice.id, categoryId: null }],
      kind: 'discount',
      discountType: 'fixed',
      discountValue: 2,
      startsAt: new Date(now - 3_600_000),
      endsAt: new Date(now + 3_600_000),
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      needsReview: false,
      active: true,
      createdAt: new Date(now - 7_200_000),
      createdBy: null,
      slots: [],
    };
    const base = makeSale();
    seed(
      review({
        request: {
          ...base.request,
          items: [{ productId: rice.id, quantity: 1, unitPrice: 10, modifierIds: [], modifierPriceDelta: 0, weightGrams: 500 }],
          amount: 8,
          expectedTotal: 8,
        },
      })
    );
    catalog.products = [rice];
    catalog.promotions = [promotion];

    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: true });
    // 20/kg x 500 g = 10.00 line, fixed 2.00 per kg = 1.00 off
    expect(cart().items).toMatchObject([
      { weightGrams: 500, unitPrice: 20, lineTotal: 9, promotionId: promotion.id },
    ]);
  });

  it('a weighed line recorded with quantity 2 is refused by the resolver and leaves the cart empty', async () => {
    const rice: Product = { ...PRODUCT, basePrice: 20, soldByWeight: true };
    const base = makeSale();
    seed(
      review({
        request: {
          ...base.request,
          items: [{ productId: rice.id, quantity: 2, unitPrice: 10, modifierIds: [], modifierPriceDelta: 0, weightGrams: 500 }],
          amount: 10,
          expectedTotal: 10,
        },
      })
    );
    catalog.products = [rice];
    catalog.promotions = [];

    const res = await mount().reRing(only().id, ticket());

    expect(res.ok).toBe(false);
    expect(cart().items).toHaveLength(0);
  });

  it('fillReRingCart adds ONE weighed line for a quantity-2 weighed line and warns', () => {
    const rice: Product = { ...PRODUCT, basePrice: 20, soldByWeight: true };
    useCartStore.getState().clearCart();
    fillReRingCart(
      [{ product: rice, modifiers: [], quantity: 2, weightGrams: 500, notes: '', unitPrice: undefined, promotionId: null }],
      { saleId: 's', approvedBy: MANAGER, approvalId: 'a' } as never
    );
    expect(cart().items).toHaveLength(1);
    expect(cart().items[0]).toMatchObject({ weightGrams: 500, quantity: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      'offline_sale.rering.weighed_quantity_ignored',
      expect.objectContaining({ productId: rice.id, quantity: 2 })
    );
  });

  it('re-ring with higher price proposes a fixed discount equal to the difference', async () => {
    seed(review());
    catalog.products = [withPrice(5)];

    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'rering', paidTotal: 9 } });
    expect(cart().items.map(i => [i.product.id, i.quantity, i.unitPrice])).toEqual([
      [PRODUCT.id, 2, 5],
    ]);
    expect(reRingAdjustment(9, cartTotal())).toEqual({
      suggestedDiscount: { amount: 1 },
      customerOverpaid: null,
    });
    // nothing is closed, audited or edited by filling the cart
    expect(only().status).toBe('needs_review');
    expect(auditCalls()).toHaveLength(0);
  });

  it('re-ring with lower price records customerOverpaid and proposes none', async () => {
    seed(review());
    catalog.products = [withPrice(4)];

    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'rering', paidTotal: 9 } });
    expect(reRingAdjustment(9, cartTotal())).toEqual({ suggestedDiscount: null, customerOverpaid: 1 });

    // the overpayment is recorded when the new sale completes the record
    const result = completeReRing(markerOf(), TAB, cartTotal());
    expect(result.ok).toBe(true);
    expect(only()).toMatchObject({ status: 'resolved', resolution: 'rering', customerOverpaid: 1 });
  });

  it('re-ring uses a fresh idempotency key', async () => {
    seed(review());
    const key = only().request.idempotencyKey;
    // a key left behind by an earlier cart, even one that matches this sale's
    cart().setPendingIdempotencyKey(key, 'whatever');

    const res = await mount().reRing(only().id, ticket());

    expect(res.ok).toBe(true);
    expect(cart().pendingIdempotencyKey).toBeNull();
    expect(cart().pendingIdempotencyFingerprint).toBeNull();
    expect(only().request.idempotencyKey).toBe(key);
  });

  it('re-ring marks the cart with the sale, the approver and the paid total', async () => {
    seed(review());
    const t = ticket();
    await mount().reRing(only().id, t);
    expect(cart().reRing).toEqual({
      saleId: only().id,
      approvedBy: MANAGER,
      approvalId: t.approvalId,
      paidTotal: 9,
    });
  });

  it('re-ring asks the server first and fills the cart only on proceed', async () => {
    seed(review({ reRingAttemptKeys: ['direct_sale_rr_1'] }));
    let release: (reply: Reply) => void = () => undefined;
    rpc.mockImplementationOnce(
      () =>
        new Promise<Reply>(resolve => {
          release = resolve;
        })
    );
    const t = ticket();
    const pending = mount().reRing(only().id, t);
    await vi.waitFor(() => {
      expect(resolveCalls()).toHaveLength(1);
    });
    // asked, not answered: no cart, no marker
    expect(resolveArgs()).toMatchObject({
      p_intent: 'rering',
      p_sale_id: only().id,
      p_idempotency_key: only().request.idempotencyKey,
      p_rering_keys: ['direct_sale_rr_1'],
      p_approval_id: t.approvalId,
      p_approver_id: MANAGER,
    });
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();

    release(answer('proceed'));
    expect(await pending).toMatchObject({ ok: true, data: { kind: 'rering' } });
    expect(cart().items.length).toBeGreaterThan(0);
    // the approver on the marker is the server's, not the client's claim
    expect(cart().reRing).toMatchObject({ saleId: only().id, approvedBy: MANAGER, approvalId: t.approvalId });
    expect(tableReads).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });

  it('a proceed replayed for the same ticket (a lost answer) fills the cart too', async () => {
    // The client does not act on `idempotent`: the server answers a repeat from its stored row, so a
    // replayed proceed must fill the cart exactly as a first one does. Assert that equivalence.
    const filled = async (idempotent: boolean) => {
      useCartStore.getState().clearCart();
      seed(review());
      rpc.mockResolvedValueOnce(answer('proceed', { idempotent }));
      const res = await mount().reRing(only().id, ticket());
      const m = cart().reRing;
      const marker = { saleId: m?.saleId, approvedBy: m?.approvedBy, paidTotal: m?.paidTotal };
      return { res, marker, lines: cart().items.map(i => [i.product.id, i.quantity]) };
    };
    const first = await filled(false);
    const replay = await filled(true);

    expect(replay.res).toMatchObject({ ok: true, data: { kind: 'rering' } });
    expect(replay.marker).toMatchObject({ approvedBy: MANAGER });
    expect(replay.lines.length).toBeGreaterThan(0);
    expect(replay).toEqual({ ...first, res: replay.res });
    expect(resolveCalls()).toHaveLength(2);
  });

  it('a cashier role without close_tab can still re-ring with a manager ticket', async () => {
    seed(review());
    signIn(CASHIER, 'cashier');
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: true, data: { kind: 'rering' } });
    // no client read of payments (or any table): the server decides, in one call
    expect(tableReads).not.toHaveBeenCalled();
    expect(resolveCalls()).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('while the licence is restricted re-ring refuses before the server is asked and spends no approval', async () => {
    seed(review());
    license.state = 'restricted';
    const { reRing, writeOff } = mount();
    const t = ticket();

    const res = await reRing(only().id, t);

    expect(res).toMatchObject({ ok: false, error: { code: 'LICENSE_RESTRICTED' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.reRingLicenseRestricted'));
    expect(resolveCalls()).toHaveLength(0);
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();

    // nothing was spent: write-off keeps working on the same ticket while restricted
    expect((await writeOff(only().id, REASON, t)).ok).toBe(true);
    // and re-ring works again once the licence is back
    license.state = 'active';
    seed(review());
    expect((await reRing(only().id, ticket())).ok).toBe(true);
  });

  it('a failed server check refuses the re-ring and leaves the cart alone', async () => {
    seed(review());
    rpc.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();
    expect(only().status).toBe('needs_review');
  });

  it('a tampered record is not re-rung because the server check cannot run', async () => {
    seed(review());
    integrity.intact = false;
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(resolveCalls()).toHaveLength(0);
    expect(cart().items).toHaveLength(0);
  });

  it('re-ring refuses when the cart is not empty', async () => {
    seed(review());
    cart().addItem(PRODUCT, []);
    const before = cart().items;

    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(cart().items).toBe(before);
    expect(cart().reRing).toBeNull();
    expect(resolveCalls()).toHaveLength(0);
  });

  it('re-ring refuses when a product no longer exists and leaves the cart untouched', async () => {
    seed(review());
    catalog.products = [];
    const resolver = mount();
    const t = ticket();

    const res = await resolver.reRing(only().id, t);

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain('Basmati rice 1kg');
    expect(cart().items).toHaveLength(0);
    expect(cart().reRing).toBeNull();
    expect(only().status).toBe('needs_review');
    // refused before the server is asked, so the approval is still good
    expect(resolveCalls()).toHaveLength(0);

    catalog.products = [PRODUCT];
    expect((await mount().reRing(only().id, t)).ok).toBe(true);
  });

  it('re-ring refuses when the catalog or prices have not loaded', async () => {
    seed(review());
    for (const key of ['products', 'promotions', 'settings'] as const) {
      const saved = catalog[key];
      catalog[key] = undefined;
      const res = await mount().reRing(only().id, ticket());
      expect(res, key).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
      expect(cart().items, key).toHaveLength(0);
      expect(resolveCalls(), key).toHaveLength(0);
      catalog[key] = saved;
    }
  });

  it('re-ring rebuilds loose-weight lines, modifiers and notes from the record', async () => {
    const MOD = '99999999-9999-4999-8999-999999999991';
    const LOOSE = '33333333-3333-4333-8333-333333333334';
    const modifier = { id: MOD, name: 'Gift wrap', priceDelta: 0.5, sortOrder: 0 };
    catalog.products = [
      { ...PRODUCT, modifiers: [modifier] },
      { ...PRODUCT, id: LOOSE, name: 'Loose atta', basePrice: 2, soldByWeight: true },
    ];
    const base = makeSale().request;
    seed(
      review({
        request: {
          ...base,
          items: [
            {
              ...base.items[0]!,
              quantity: 1,
              modifierIds: [MOD],
              modifierPriceDelta: 0.5,
              notes: 'fragile',
            },
            {
              productId: LOOSE,
              quantity: 1,
              unitPrice: 1.5,
              modifierIds: [],
              modifierPriceDelta: 0,
              weightGrams: 750,
            },
          ],
          expectedTotal: 6.5,
        },
        lines: [
          { productId: PRODUCT.id, name: 'Basmati rice 1kg', categoryName: 'Rice', modifierNames: ['Gift wrap'] },
          { productId: LOOSE, name: 'Loose atta', categoryName: null, modifierNames: [] },
        ],
      })
    );

    const res = await mount().reRing(only().id, ticket());

    expect(res).toMatchObject({ ok: true, data: { kind: 'rering', paidTotal: 6.5 } });
    const [rice, atta] = cart().items;
    expect(rice).toMatchObject({ quantity: 1, notes: 'fragile', lineTotal: 5 });
    expect(rice?.selectedModifiers.map(m => m.id)).toEqual([MOD]);
    expect(atta).toMatchObject({ weightGrams: 750, quantity: 1, lineTotal: 1.5 });
  });

  it('re-ring refuses a loose-weight line whose product is no longer sold by weight', async () => {
    const base = makeSale().request;
    seed(
      review({ request: { ...base, items: [{ ...base.items[0]!, quantity: 1, weightGrams: 500 }] } })
    );
    const res = await mount().reRing(only().id, ticket());
    expect(res.ok).toBe(false);
    expect(cart().items).toHaveLength(0);
  });

  it("re-ring prices at today's live promotion, as the checkout screen does", async () => {
    seed(review());
    const promotion: Promotion = {
      id: '11111111-1111-4111-8111-111111111112',
      name: 'Rice week',
      targets: [],
      kind: 'discount',
      discountType: 'percent',
      discountValue: 20,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000),
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      needsReview: false,
      active: true,
      createdAt: new Date(Date.now() - 86_400_000),
      createdBy: null,
      slots: [],
    };
    catalog.promotions = [promotion];

    await mount().reRing(only().id, ticket());

    expect(cart().items[0]).toMatchObject({ unitPrice: 3.6, promotionId: promotion.id });
  });

  it('the approval is spent once the cart is filled', async () => {
    seed(review());
    const t = ticket();
    expect((await mount().reRing(only().id, t)).ok).toBe(true);
    cart().clearCart();
    const again = await mount().reRing(only().id, t);
    expect(again).toMatchObject({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
    expect(cart().items).toHaveLength(0);
  });

  it('abandoning the re-ring cart leaves the record in review', async () => {
    seed(review());
    const before = only();
    await mount().reRing(only().id, ticket());
    expect(cart().reRing).not.toBeNull();

    cart().clearCart();

    expect(cart().reRing).toBeNull();
    expect(cart().items).toHaveLength(0);
    expect(only()).toBe(before);
    // and it can still be retried, or re-rung with a new approval
    expect(asSeller(() => mount().retry(only().id)).ok).toBe(true);
  });

  it('retry and write off are refused while a re-ring of the sale sits in the cart', async () => {
    seed(review());
    const resolver = mount();
    await resolver.reRing(only().id, ticket());

    expect(asSeller(() => resolver.retry(only().id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const w = await resolver.writeOff(only().id, REASON, ticket());
    expect(w).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(only().status).toBe('needs_review');
    expect(auditCalls()).toHaveLength(0);
  });

  it('a re-ring whose first completion could not be stored cannot be started again', async () => {
    seed(review());
    await mount().reRing(only().id, ticket());
    const marker = markerOf();
    const write = failWrites();
    expect(completeReRing(marker, TAB, 9).ok).toBe(false);
    write.mockRestore();
    expect(unlinkedReRingTab(only().id)).toBe(TAB);

    cart().clearCart();
    const res = await mount().reRing(only().id, ticket());
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error.message).toContain(TAB.slice(0, 8));
    expect(cart().items).toHaveLength(0);

    // the unlinked memory is module level: link it for real so later tests start clean
    expect(completeReRing(marker, TAB, 9).ok).toBe(true);
  });

  it('retry is refused for a sale whose re-ring was paid but not linked', async () => {
    seed(review());
    const resolver = mount();
    await resolver.reRing(only().id, ticket());
    const marker = markerOf();
    const write = failWrites();
    expect(completeReRing(marker, TAB, 9).ok).toBe(false);
    write.mockRestore();
    // Done on the receipt screen clears the cart and with it the marker
    cart().clearCart();
    rpc.mockClear();

    expect(asSeller(() => resolver.retry(only().id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const w = await resolver.writeOff(only().id, REASON, ticket());
    expect(w).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(await resolver.reRing(only().id, ticket())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(only().status).toBe('needs_review');
    expect(rpc).not.toHaveBeenCalled();

    // the unlinked memory is module level: link it for real so later tests start clean
    expect(completeReRing(marker, TAB, 9).ok).toBe(true);
  });

  it('re-ring is refused offline and for a record that is not in review', async () => {
    seed(review(), makeSale({ id: '88888888-8888-4888-8888-888888888888' }));
    online.value = false;
    expect(await mount().reRing(only().id, ticket())).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_OFFLINE' },
    });
    online.value = true;
    const queued = records()[1]?.id ?? '';
    expect(await mount().reRing(queued, ticket())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(cart().items).toHaveLength(0);
  });

  it('re-ring never edits the stored request', async () => {
    seed(review());
    const before = JSON.stringify(only().request);
    catalog.products = [withPrice(7)];
    await mount().reRing(only().id, ticket());
    expect(JSON.stringify(only().request)).toBe(before);
  });
});

describe('the record an outcome returns', () => {
  // The dialog builds its notices from `data.record`: it must be the record the store holds
  // after the transition, not the one that was read before it.
  it('is the stored post-transition record for every success kind', async () => {
    seed(review());
    const writtenOff = await mount().writeOff(only().id, REASON, ticket());
    expect(writtenOff.ok && writtenOff.data.kind).toBe('written_off');
    if (writtenOff.ok && 'record' in writtenOff.data) expect(writtenOff.data.record).toBe(only());

    seed(review({ lastCode: 'SHIFT_NOT_OPEN' }));
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const recorded = await mount().writeOff(only().id, REASON, ticket());
    expect(recorded.ok && recorded.data.kind).toBe('already_recorded');
    if (recorded.ok && 'record' in recorded.data) expect(recorded.data.record).toBe(only());

    seed(review());
    rpc.mockResolvedValueOnce(answer('already_recorded', { tabId: TAB }));
    const reRungRecorded = await mount().reRing(only().id, ticket());
    expect(reRungRecorded.ok && reRungRecorded.data.kind).toBe('already_recorded');
    if (reRungRecorded.ok && 'record' in reRungRecorded.data) {
      expect(reRungRecorded.data.record).toBe(only());
    }

    seed(
      makeSale({
        id: '88888888-8888-4888-8888-888888888888',
        staffId: OTHER_CASHIER,
        request: { ...makeSale().request, idempotencyKey: 'direct_sale_other' },
      })
    );
    const moved = await mount().moveToReview(only().id, ticket());
    expect(moved.ok && moved.data.kind).toBe('moved_to_review');
    if (moved.ok && 'record' in moved.data) expect(moved.data.record).toBe(only());
  });
});

describe('a write-off whose answer was lost', () => {
  const lostAnswer = () =>
    rpc
      .mockResolvedValueOnce(failure({ code: '', message: 'Failed to fetch' }, 0))
      .mockResolvedValueOnce(failure({ code: '', message: 'Failed to fetch' }, 0));

  it('retry is refused after a write-off whose answer was lost', async () => {
    seed(review({ staffId: CASHIER }));
    lostAnswer();
    const failed = await mount().writeOff(only().id, REASON, ticket());
    expect(failed).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(only()).toMatchObject({ status: 'needs_review', resolutionOutcomeUnknown: true });

    const res = asSeller(() => mount().retry(only().id));
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.retryAfterLostWriteOff'));
    expect(only().status).toBe('needs_review');
  });

  it('a refusal does not clear the lost-answer flag', async () => {
    seed(review({ staffId: CASHIER }));
    lostAnswer();
    await mount().writeOff(only().id, REASON, ticket());
    expect(only().resolutionOutcomeUnknown).toBe(true);

    rpc.mockResolvedValueOnce(refused('VALIDATION_ERROR'));
    await mount().writeOff(only().id, REASON, ticket());
    expect(only()).toMatchObject({ status: 'needs_review', resolutionOutcomeUnknown: true });
    expect(asSeller(() => mount().retry(only().id)).ok).toBe(false);
  });

  it('an already-written-off answer sets the lost-answer flag', async () => {
    seed(review({ staffId: CASHIER }));
    expect(only().resolutionOutcomeUnknown).toBe(false);
    rpc.mockResolvedValueOnce(refused('ALREADY_WRITTEN_OFF'));
    await mount().writeOff(only().id, REASON, ticket());
    expect(only()).toMatchObject({ status: 'needs_review', resolutionOutcomeUnknown: true });
    expect(asSeller(() => mount().retry(only().id)).ok).toBe(false);
  });

  it('a lost re-ring answer leaves re-ring available', async () => {
    seed(review({ staffId: CASHIER }));
    lostAnswer();
    const failed = await mount().reRing(only().id, ticket());
    expect(failed).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(only()).toMatchObject({ status: 'needs_review', resolutionOutcomeUnknown: false });
  });

  it('an already-written-off answer to a re-ring still sets the flag', async () => {
    seed(review({ staffId: CASHIER }));
    rpc.mockResolvedValueOnce(refused('ALREADY_WRITTEN_OFF'));
    await mount().reRing(only().id, ticket());
    expect(only()).toMatchObject({ status: 'needs_review', resolutionOutcomeUnknown: true });
  });

  it('re-ring is refused while the lost-answer flag is set', async () => {
    seed(review({ staffId: CASHIER, resolutionOutcomeUnknown: true }));
    const res = await mount().reRing(only().id, ticket());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.reRingAfterLostWriteOff'));
    expect(resolveCalls()).toHaveLength(0);
  });

  it('the flag clears only when the sale is resolved', async () => {
    seed(review({ staffId: CASHIER }));
    lostAnswer();
    await mount().writeOff(only().id, REASON, ticket());
    expect(only().resolutionOutcomeUnknown).toBe(true);

    // the answer that writes it off clears it
    seed(review({ resolutionOutcomeUnknown: true }));
    rpc.mockResolvedValueOnce(answer('written_off', { idempotent: true }));
    expect(await mount().writeOff(only().id, REASON, ticket())).toMatchObject({ ok: true });
    expect(only()).toMatchObject({ status: 'resolved', resolutionOutcomeUnknown: false });
  });
});

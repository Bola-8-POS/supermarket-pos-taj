import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantProductRow, AssistantSalesSummary } from '@shared/lib/domain';
import type { PreviewReply } from '@shared/lib/local-assistant/presenter';
import { ok, err } from '@shared/lib/result';
import {
  MAX_TURNS_PER_MINUTE,
  resetGatewayState,
  runApproval,
  runBatchChoice,
  runCancel,
  runChoice,
  runTurn,
  type GatewayDeps,
  type WriteDeps,
} from './gateway';

const ROW: AssistantProductRow = {
  productId: '11111111-1111-4111-8111-111111111111',
  name: 'Ghee 500g',
  price: 12.5,
  quantityOnHand: 7,
  barcode: null,
};
const LOOKUP = '{"kind":"product.lookup","args":{"query":"ghee"}}';
const SUMMARY: AssistantSalesSummary = {
  cajaId: '22222222-2222-4222-8222-222222222222',
  openedAt: '2026-11-08T14:00:00Z',
  closedAt: null,
  summary: {
    totalRevenue: 250,
    cashSales: 100,
    cardSales: 120,
    rappiSales: 10,
    uberEatsSales: 0,
    bankTransferSales: 20,
    bankTransferPending: 0,
    orderCount: 9,
    tabCount: 0,
    totalExpenses: 0,
    totalIncome: 0,
    netBalance: 250,
  },
};

function makeDeps(content: string | null, over: Partial<GatewayDeps> = {}) {
  const lookup = vi.fn().mockResolvedValue(ok({ rows: [ROW], more: false }));
  const propose = vi
    .fn()
    .mockResolvedValue(content === null ? err({ code: 'MODEL_TIMEOUT' }) : ok(content));
  const expiry = vi.fn().mockResolvedValue(ok({ rows: [], more: false }));
  const lowStock = vi.fn().mockResolvedValue(ok({ type: 'rows', rows: [], more: false, supplierName: null }));
  const sales = vi.fn().mockResolvedValue(ok(SUMMARY));
  const deps: GatewayDeps = {
    model: { propose },
    reads: { 'product.lookup': lookup, 'expiry.list': expiry, 'stock.low': lowStock, 'sales.summary': sales },
    can: () => true,
    ...over,
  };
  return { deps, lookup, propose, expiry, lowStock, sales };
}

describe('runTurn', () => {
  beforeEach(() => { resetGatewayState(); });

  it('runs the lookup once and returns the typed result', async () => {
    const { deps, lookup } = makeDeps(LOOKUP);
    const res = await runTurn('price of ghee', deps);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('ghee');
    expect(res).toEqual({ type: 'result', kind: 'product.lookup', rows: [ROW], more: false });
  });

  it('runs the expiry read with the proposed window and returns its rows', async () => {
    const { deps, expiry, lookup } = makeDeps('{"kind":"expiry.list","args":{"withinDays":7}}');
    const expRow = { productId: ROW.productId, name: 'Milk', expiryDate: '2026-11-10', daysUntilExpiry: 2 };
    expiry.mockResolvedValue(ok({ rows: [expRow], more: false }));
    const res = await runTurn('what expires this week', deps);
    expect(expiry).toHaveBeenCalledWith(7);
    expect(lookup).not.toHaveBeenCalled();
    expect(res).toEqual({ type: 'result', kind: 'expiry.list', rows: [expRow], more: false });
  });

  it('runs the low-stock read with the proposed supplier query', async () => {
    const { deps, lowStock } = makeDeps('{"kind":"stock.low","args":{"supplierQuery":"Sysco"}}');
    const row = { productId: ROW.productId, name: 'Ghee', quantityOnHand: 2, lowStockThreshold: 10 };
    lowStock.mockResolvedValue(ok({ type: 'rows', rows: [row], more: false, supplierName: 'Sysco' }));
    expect(await runTurn('low stock from Sysco', deps)).toEqual({
      type: 'result',
      kind: 'stock.low',
      rows: [row],
      more: false,
      supplierName: 'Sysco',
    });
    expect(lowStock).toHaveBeenCalledWith({ query: 'Sysco' });
  });

  it('returns the typed supplier choice without a second model turn, and runChoice re-runs only the read', async () => {
    const { deps, lowStock, propose } = makeDeps('{"kind":"stock.low","args":{"supplierQuery":"S"}}');
    const options = [
      { id: 'a1111111-1111-4111-8111-111111111111', name: 'Sysco' },
      { id: 'b2222222-2222-4222-8222-222222222222', name: 'Susan Foods' },
    ];
    lowStock.mockResolvedValueOnce(ok({ type: 'choose', options }));
    expect(await runTurn('low stock from S', deps)).toEqual({ type: 'choose', kind: 'stock.low', options });
    expect(propose).toHaveBeenCalledTimes(1);

    lowStock.mockResolvedValueOnce(ok({ type: 'rows', rows: [], more: false, supplierName: 'Sysco' }));
    const res = await runChoice(options[0]!.id, deps);
    expect(lowStock).toHaveBeenLastCalledWith({ supplierId: options[0]!.id });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ type: 'result', kind: 'stock.low', supplierName: 'Sysco' });
  });

  it('refuses sales.summary before any read when the role lacks view_reports', async () => {
    const { deps, sales } = makeDeps('{"kind":"sales.summary","args":{}}', { can: a => a !== 'view_reports' });
    expect(await runTurn('sales today', deps)).toEqual({ type: 'refusal', code: 'AUTH_FORBIDDEN' });
    expect(sales).not.toHaveBeenCalled();
  });

  it('returns the sales summary for a role that holds view_reports', async () => {
    const { deps, sales } = makeDeps('{"kind":"sales.summary","args":{}}');
    expect(await runTurn('sales today', deps)).toEqual({ type: 'result', kind: 'sales.summary', summary: SUMMARY });
    expect(sales).toHaveBeenCalledTimes(1);
  });

  it('turns a refuse proposal into a refusal and calls no read', async () => {
    const { deps, lookup } = makeDeps('{"kind":"refuse","reason":"unsupported"}');
    expect(await runTurn('delete everything', deps)).toEqual({
      type: 'refusal',
      code: 'MODEL_REFUSED_UNSUPPORTED',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'sure, the price is 5'],
    ['an unknown kind', '{"kind":"product.delete","args":{"query":"x"}}'],
    ['an extra key', '{"kind":"product.lookup","args":{"query":"x"},"y":1}'],
    ['an out-of-range query', `{"kind":"product.lookup","args":{"query":"${'a'.repeat(81)}"}}`],
  ])('maps %s to INVALID_PROPOSAL without a read', async (_n, content) => {
    const { deps, lookup } = makeDeps(content);
    expect(await runTurn('price of ghee', deps)).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('passes a model error code through', async () => {
    const { deps } = makeDeps(null);
    expect(await runTurn('price of ghee', deps)).toEqual({ type: 'refusal', code: 'MODEL_TIMEOUT' });
  });

  it('surfaces DATA_UNAVAILABLE from the read', async () => {
    const { deps, lookup } = makeDeps(LOOKUP);
    lookup.mockResolvedValue(err({ code: 'DATA_UNAVAILABLE' }));
    expect(await runTurn('price of ghee', deps)).toEqual({ type: 'refusal', code: 'DATA_UNAVAILABLE' });
  });

  it('screens input before the model is called', async () => {
    const { deps, propose } = makeDeps(LOOKUP);
    expect(await runTurn('a'.repeat(401), deps)).toMatchObject({ type: 'refusal', code: 'INPUT_TOO_LONG' });
    expect(await runTurn('cobrar 4111111111111111', deps)).toMatchObject({ code: 'PAYMENT_DATA' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('rate limits after MAX_TURNS_PER_MINUTE turns and recovers after the window', async () => {
    let t = 1_000;
    const { deps } = makeDeps(LOOKUP, { now: () => t });
    for (let i = 0; i < MAX_TURNS_PER_MINUTE; i++) {
      expect((await runTurn('price of ghee', deps)).type).toBe('result');
    }
    expect(await runTurn('price of ghee', deps)).toEqual({ type: 'refusal', code: 'RATE_LIMITED' });
    t += 61_000;
    expect((await runTurn('price of ghee', deps)).type).toBe('result');
  });

  it('allows one turn in flight', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { deps, propose } = makeDeps(LOOKUP);
    propose.mockImplementation(() => new Promise(res => (release = res)));
    const first = runTurn('price of ghee', deps);
    expect(await runTurn('price of rice', deps)).toEqual({ type: 'refusal', code: 'RATE_LIMITED' });
    release(ok(LOOKUP));
    expect((await first).type).toBe('result');
  });

  it('returns cancelled and runs no read when the signal aborts mid-turn', async () => {
    const ctrl = new AbortController();
    const { deps, lookup, propose } = makeDeps(LOOKUP, { signal: ctrl.signal });
    propose.mockImplementation(() => {
      ctrl.abort();
      return Promise.resolve(ok(LOOKUP));
    });
    expect(await runTurn('price of ghee', deps)).toEqual({ type: 'cancelled' });
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Write branch (Plan 29-03): stage -> preview -> approve/cancel
// ---------------------------------------------------------------------------
const PRODUCT_A = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const ADJUST = JSON.stringify({
  kind: 'inventory.adjust',
  args: { reason: 'waste', items: [{ query: 'ghee', delta: -2 }] },
});
const ITEM = { product_id: PRODUCT_A, name: 'Ghee 500g', before: 10, after: 8 };

function makeWriteDeps(content: string, over: Partial<WriteDeps> = {}, deps: Partial<GatewayDeps> = {}) {
  const base = makeDeps(content, deps);
  base.lookup.mockResolvedValue(ok({ rows: [{ ...ROW, productId: PRODUCT_A, quantityOnHand: 10 }], more: false }));
  const writes = {
    gate: vi.fn().mockResolvedValue(ok({ ok: true, locked: false, until: null })),
    stage: vi.fn().mockResolvedValue(
      ok({ ok: true, proposal_id: PROPOSAL_ID, payload_hash: 'h', expires_at: '2026-11-08T12:02:00Z', expires_in_seconds: 120, items: [ITEM] })
    ),
    approve: vi.fn().mockResolvedValue(ok({ ok: true, status: 'executed', items: [ITEM] })),
    cancel: vi.fn().mockResolvedValue(ok({ ok: true })),
    applyPrices: vi.fn(),
    recordRejection: vi.fn().mockResolvedValue(undefined),
    terminalId: 'T1',
    modelTag: 'm@r',
    ...over,
  } satisfies WriteDeps;
  base.deps.writes = writes;
  return { ...base, writes };
}

describe('runTurn: inventory.adjust', () => {
  beforeEach(() => { resetGatewayState(); });

  it('resolves the product, stages with the screened text and returns the server preview', async () => {
    const { deps, writes } = makeWriteDeps(ADJUST);
    const res = await runTurn('write off 2 ghee, expired', deps);
    expect(writes.gate).toHaveBeenCalledTimes(1);
    expect(writes.stage).toHaveBeenCalledWith({
      kind: 'inventory.adjust',
      reason: 'waste',
      items: [{ product_id: PRODUCT_A, delta: -2, expected_quantity: 10 }],
      terminalId: 'T1',
      model: 'm@r',
      policyVersion: expect.any(String) as string,
      promptVersion: expect.any(String) as string,
      rawText: 'write off 2 ghee, expired',
    });
    expect(res).toEqual({
      type: 'preview',
      kind: 'inventory.adjust',
      proposalId: PROPOSAL_ID,
      payloadHash: 'h',
      expiresInSeconds: 120,
      items: [ITEM],
    });
    expect(writes.recordRejection).not.toHaveBeenCalled();
  });

  it('returns AUTH_FORBIDDEN, records the rejection and never stages when the role lacks adjust_inventory', async () => {
    const { deps, writes } = makeWriteDeps(ADJUST, {}, { can: () => false });
    expect(await runTurn('write off 2 ghee', deps)).toEqual({ type: 'refusal', code: 'AUTH_FORBIDDEN' });
    expect(writes.recordRejection).toHaveBeenCalledTimes(1);
    expect(writes.recordRejection).toHaveBeenCalledWith('AUTH_FORBIDDEN', 'inventory.adjust');
    expect(writes.gate).toHaveBeenCalledTimes(1);
    expect(writes.stage).not.toHaveBeenCalled();
  });

  it('fails closed on a locked assistant or a gate error, without staging', async () => {
    const locked = makeWriteDeps(ADJUST, { gate: vi.fn().mockResolvedValue(ok({ ok: true, locked: true, until: 'x' })) });
    expect(await runTurn('write off 2 ghee', locked.deps)).toEqual({
      type: 'refusal',
      code: 'ASSISTANT_LOCKED',
      until: 'x',
    });
    expect(locked.writes.stage).not.toHaveBeenCalled();
    resetGatewayState();
    const down = makeWriteDeps(ADJUST, { gate: vi.fn().mockResolvedValue(err({ code: 'DATA_UNAVAILABLE' })) });
    expect(await runTurn('write off 2 ghee', down.deps)).toEqual({ type: 'refusal', code: 'DATA_UNAVAILABLE' });
    expect(down.writes.stage).not.toHaveBeenCalled();
  });

  it('refuses without writes wired (read-only caller)', async () => {
    const { deps } = makeDeps(ADJUST);
    expect(await runTurn('write off 2 ghee', deps)).toEqual({ type: 'refusal', code: 'DATA_UNAVAILABLE' });
  });

  it('passes a stage refusal through without recording it again (the server already did)', async () => {
    const { deps, writes } = makeWriteDeps(ADJUST, { stage: vi.fn().mockResolvedValue(err({ code: 'STALE_TARGET' })) });
    expect(await runTurn('write off 2 ghee', deps)).toEqual({ type: 'refusal', code: 'STALE_TARGET' });
    expect(writes.recordRejection).not.toHaveBeenCalled();
  });

  it('counts a model refusal, a parse failure and a screen refusal once each', async () => {
    const refuse = makeWriteDeps('{"kind":"refuse","reason":"unsafe"}');
    await runTurn('do bad things', refuse.deps);
    expect(refuse.writes.recordRejection).toHaveBeenCalledWith('MODEL_REFUSED_UNSAFE', 'refuse');
    resetGatewayState();
    const garbage = makeWriteDeps('not json');
    await runTurn('write off 2 ghee', garbage.deps);
    expect(garbage.writes.recordRejection).toHaveBeenCalledWith('INVALID_PROPOSAL', null);
    const screened = makeWriteDeps(ADJUST);
    await runTurn('a'.repeat(401), screened.deps);
    expect(screened.writes.recordRejection).toHaveBeenCalledWith('INPUT_TOO_LONG', null);
    expect(screened.writes.recordRejection).toHaveBeenCalledTimes(1);
  });

  it('does not count NOT_FOUND, and names the product only when the staff typed it', async () => {
    const typed = makeWriteDeps(ADJUST);
    typed.lookup.mockResolvedValue(ok({ rows: [], more: false }));
    expect(await runTurn('write off 2 ghee', typed.deps)).toEqual({ type: 'refusal', code: 'NOT_FOUND', query: 'ghee' });
    expect(typed.writes.recordRejection).not.toHaveBeenCalled();
    expect(typed.writes.stage).not.toHaveBeenCalled();
    resetGatewayState();
    const invented = makeWriteDeps(ADJUST);
    invented.lookup.mockResolvedValue(ok({ rows: [], more: false }));
    expect(await runTurn('write off the stale stuff', invented.deps)).toEqual({ type: 'refusal', code: 'NOT_FOUND' });
  });

  it('refuses a duplicate product across items before staging and counts it', async () => {
    const two = JSON.stringify({
      kind: 'inventory.adjust',
      args: { reason: 'waste', items: [{ query: 'ghee', delta: -1 }, { query: 'ghee pure', delta: -1 }] },
    });
    const { deps, writes } = makeWriteDeps(two);
    expect(await runTurn('write off ghee and ghee pure', deps)).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(writes.stage).not.toHaveBeenCalled();
    expect(writes.recordRejection).toHaveBeenCalledWith('INVALID_PROPOSAL', 'inventory.adjust');
  });
});

describe('runApproval and runCancel', () => {
  const preview: PreviewReply = {
    type: 'preview',
    kind: 'inventory.adjust',
    proposalId: PROPOSAL_ID,
    payloadHash: 'h',
    expiresInSeconds: 120,
    items: [ITEM],
  };

  it('approves with every binding and returns the executed outcome', async () => {
    const { writes } = makeWriteDeps(ADJUST);
    const res = await runApproval(preview, 'approver-1', 'ticket-1', { writes });
    expect(writes.approve).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      payloadHash: 'h',
      approvalId: 'ticket-1',
      approverId: 'approver-1',
      terminalId: 'T1',
    });
    expect(res).toEqual({ type: 'outcome', kind: 'inventory.adjust', status: 'executed', items: [ITEM] });
  });

  it('turns a refused approval into a typed refusal (no outcome)', async () => {
    const { writes } = makeWriteDeps(ADJUST, { approve: vi.fn().mockResolvedValue(err({ code: 'STOCK_CHANGED' })) });
    expect(await runApproval(preview, 'a', 't', { writes })).toEqual({ type: 'refusal', code: 'STOCK_CHANGED' });
  });

  it('cancel and expiry call the server once and end the preview', async () => {
    const { writes } = makeWriteDeps(ADJUST);
    expect(await runCancel(preview, 'user', { writes })).toMatchObject({ type: 'outcome', status: 'cancelled' });
    expect(writes.cancel).toHaveBeenLastCalledWith(PROPOSAL_ID, 'user');
    expect(await runCancel(preview, 'expired', { writes })).toMatchObject({ type: 'outcome', status: 'expired' });
    expect(writes.cancel).toHaveBeenLastCalledWith(PROPOSAL_ID, 'expired');
    expect(writes.cancel).toHaveBeenCalledTimes(2);
  });

  it('WR-03: a stock approve whose response was lost surfaces RESULT_UNCONFIRMED (check first), not "try again"', async () => {
    const { writes } = makeWriteDeps(ADJUST, { approve: vi.fn().mockResolvedValue(err({ code: 'RESULT_UNCONFIRMED' })) });
    expect(await runApproval(preview, 'a', 't', { writes })).toEqual({ type: 'refusal', code: 'RESULT_UNCONFIRMED' });
  });

  it('WR-01: an expiry cancel that finds the proposal already used reports nothing, so it cannot overwrite a committed write', async () => {
    const { writes } = makeWriteDeps(ADJUST, { cancel: vi.fn().mockResolvedValue(err({ code: 'ALREADY_USED' })) });
    expect(await runCancel(preview, 'expired', { writes })).toBeNull();
  });

  it('WR-01: a cancel whose call failed still ends the preview on screen (the staged proposal times out server-side)', async () => {
    const { writes } = makeWriteDeps(ADJUST, { cancel: vi.fn().mockResolvedValue(err({ code: 'DATA_UNAVAILABLE' })) });
    expect(await runCancel(preview, 'expired', { writes })).toMatchObject({ type: 'outcome', status: 'expired' });
  });
});

describe('inventory.adjust batches and typed product choice', () => {
  beforeEach(() => { resetGatewayState(); });

  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const row = (i: number, qty: number | null = 10): AssistantProductRow => ({
    productId: uuid(i),
    name: `Product ${i}`,
    price: 5,
    quantityOnHand: qty,
    barcode: null,
  });
  const batchJson = (queries: string[], delta = -1) =>
    JSON.stringify({
      kind: 'inventory.adjust',
      args: { reason: 'waste', items: queries.map(query => ({ query, delta })) },
    });
  /** Lookup answers by query: `item N` -> one product N; `amb` -> three products 101-103. */
  function answer(lookup: ReturnType<typeof makeWriteDeps>['lookup']) {
    lookup.mockImplementation((q: string) => {
      if (q === 'amb') return Promise.resolve(ok({ rows: [row(101), row(102), row(103)], more: false }));
      if (q === 'amb2') return Promise.resolve(ok({ rows: [row(201), row(202)], more: false }));
      const n = Number(q.replace('item ', ''));
      return Promise.resolve(ok({ rows: [row(n)], more: false }));
    });
  }

  it('stages a full batch of 25 items in one call', async () => {
    const queries = Array.from({ length: 25 }, (_v, i) => `item ${i + 1}`);
    const { deps, lookup, writes } = makeWriteDeps(batchJson(queries));
    answer(lookup);
    const res = await runTurn('write off these 25 items', deps);
    expect(lookup).toHaveBeenCalledTimes(25);
    expect(writes.stage).toHaveBeenCalledTimes(1);
    const input = vi.mocked(writes.stage).mock.calls[0]?.[0] as { items: unknown[] };
    expect(input.items).toHaveLength(25);
    expect(res.type).toBe('preview');
  });

  it('a 26-item proposal is an INVALID_PROPOSAL refusal that is counted and reads nothing', async () => {
    const queries = Array.from({ length: 26 }, (_v, i) => `item ${i + 1}`);
    const { deps, lookup, writes } = makeWriteDeps(batchJson(queries));
    expect(await runTurn('write off 26 items', deps)).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(writes.recordRejection).toHaveBeenCalledWith('INVALID_PROPOSAL', null);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks the staff to pick when an item matches several products, and stages only after every choice, with no model call', async () => {
    const { deps, lookup, writes, propose } = makeWriteDeps(batchJson(['item 1', 'amb', 'amb2']));
    answer(lookup);
    const first = await runTurn('write off item 1, amb and amb2', deps);
    expect(first.type).toBe('choose-products');
    expect(writes.stage).not.toHaveBeenCalled();
    if (first.type !== 'choose-products') return;
    const { pending } = first;
    expect(pending.items.map(i => i.candidates.length)).toEqual([1, 3, 2]);
    expect(pending.items.map(i => i.chosenId)).toEqual([uuid(1), null, null]);
    // The typed words are kept as labels (they are in the staff text); nothing else is.
    expect(pending.items.map(i => i.label)).toEqual(['item 1', 'amb', 'amb2']);

    const afterOne = await runBatchChoice(pending, 1, uuid(102), deps);
    expect(afterOne.type).toBe('choose-products');
    expect(writes.stage).not.toHaveBeenCalled();
    if (afterOne.type !== 'choose-products') return;
    expect(afterOne.pending.items.map(i => i.chosenId)).toEqual([uuid(1), uuid(102), null]);

    const done = await runBatchChoice(afterOne.pending, 2, uuid(202), deps);
    expect(done.type).toBe('preview');
    expect(writes.stage).toHaveBeenCalledTimes(1);
    const input = vi.mocked(writes.stage).mock.calls[0]?.[0] as { items: { product_id: string }[]; rawText: string };
    expect(input.items.map(i => i.product_id)).toEqual([uuid(1), uuid(102), uuid(202)]);
    expect(input.rawText).toBe('write off item 1, amb and amb2');
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('refuses a choice that is not one of the offered candidates (counted), without staging', async () => {
    const { deps, lookup, writes } = makeWriteDeps(batchJson(['amb']));
    answer(lookup);
    const first = await runTurn('write off amb', deps);
    if (first.type !== 'choose-products') throw new Error('expected a choice');
    expect(await runBatchChoice(first.pending, 0, uuid(999), deps)).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(await runBatchChoice(first.pending, 5, uuid(101), deps)).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(writes.recordRejection).toHaveBeenCalledTimes(2);
    expect(writes.stage).not.toHaveBeenCalled();
  });

  it('never shows model wording the staff did not type: the label is null and the choice is numbered', async () => {
    const { deps, lookup } = makeWriteDeps(batchJson(['amb']));
    answer(lookup);
    const res = await runTurn('write off the milk', deps);
    expect(res.type === 'choose-products' && res.pending.items[0]?.label).toBeNull();
  });

  it('refuses two items that end up on the same product, before staging', async () => {
    const { deps, lookup, writes } = makeWriteDeps(batchJson(['item 1', 'amb']));
    answer(lookup);
    const first = await runTurn('write off item 1 and amb', deps);
    if (first.type !== 'choose-products') throw new Error('expected a choice');
    const picked = await runBatchChoice(
      { ...first.pending, items: first.pending.items.map((it, i) => (i === 1 ? { ...it, candidates: [row(1), row(102)] } : it)) },
      1,
      uuid(1),
      deps
    );
    expect(picked).toEqual({ type: 'refusal', code: 'INVALID_PROPOSAL' });
    expect(writes.stage).not.toHaveBeenCalled();
  });

  it('skips products without a stock record: they cannot be candidates', async () => {
    const { deps, lookup, writes } = makeWriteDeps(batchJson(['amb']));
    lookup.mockResolvedValue(ok({ rows: [row(101, null), row(102, 4)], more: false }));
    const res = await runTurn('write off amb', deps);
    expect(res.type).toBe('preview');
    const input = vi.mocked(writes.stage).mock.calls[0]?.[0] as { items: { product_id: string; expected_quantity: number }[] };
    expect(input.items).toEqual([{ product_id: uuid(102), delta: -1, expected_quantity: 4 }]);
  });

  it('asks for a clearer name (uncounted) when an item matches more products than the lookup cap', async () => {
    const { deps, lookup, writes } = makeWriteDeps(batchJson(['amb']));
    lookup.mockResolvedValue(ok({ rows: [row(101)], more: true }));
    expect(await runTurn('write off amb', deps)).toEqual({ type: 'refusal', code: 'MODEL_REFUSED_AMBIGUOUS' });
    expect(writes.recordRejection).not.toHaveBeenCalled();
    expect(writes.stage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plan 29-05: product.price
// ---------------------------------------------------------------------------
describe('product.price', () => {
  beforeEach(() => { resetGatewayState(); });
  const PRICE = JSON.stringify({ kind: 'product.price', args: { items: [{ query: 'ghee', priceCents: 8950 }] } });
  const UPDATED = '2026-11-08T10:00:00.123456+00:00';
  const PRICE_ITEM = { product_id: PRODUCT_A, name: 'Ghee 500g', before: 12.5, after: 89.5, expected_updated_at: UPDATED };
  const priceRow = { ...ROW, productId: PRODUCT_A, updatedAt: UPDATED };

  function priceDeps(over: Partial<WriteDeps> = {}, deps: Partial<GatewayDeps> = {}) {
    const stage = vi.fn().mockResolvedValue(
      ok({ ok: true, proposal_id: PROPOSAL_ID, payload_hash: 'h', expires_at: '2026-11-08T12:02:00Z', expires_in_seconds: 120, items: [PRICE_ITEM] })
    );
    const made = makeWriteDeps(PRICE, { stage, ...over }, deps);
    made.lookup.mockResolvedValue(ok({ rows: [priceRow], more: false }));
    return made;
  }

  it('stages the price in currency units with the price and row version the session just read', async () => {
    const { deps, writes } = priceDeps();
    const res = await runTurn('cambia el precio del ghee a 89.50', deps);
    expect(writes.stage).toHaveBeenCalledWith({
      kind: 'product.price',
      reason: 'price_change',
      items: [{ product_id: PRODUCT_A, price: 89.5, expected_price: 12.5, expected_updated_at: UPDATED }],
      terminalId: 'T1',
      model: 'm@r',
      policyVersion: expect.any(String) as string,
      promptVersion: expect.any(String) as string,
      rawText: 'cambia el precio del ghee a 89.50',
    });
    expect(res).toMatchObject({ type: 'preview', kind: 'product.price', proposalId: PROPOSAL_ID });
  });

  it('refuses a cashier without manage_products, counts it and never stages', async () => {
    const { deps, writes } = priceDeps({}, { can: a => a !== 'manage_products' });
    expect(await runTurn('set ghee to 89.50', deps)).toEqual({ type: 'refusal', code: 'AUTH_FORBIDDEN' });
    expect(writes.recordRejection).toHaveBeenCalledWith('AUTH_FORBIDDEN', 'product.price');
    expect(writes.stage).not.toHaveBeenCalled();
  });

  it('keeps products without a stock record as candidates (a price needs none)', async () => {
    const { deps, writes, lookup } = priceDeps();
    lookup.mockResolvedValue(ok({ rows: [{ ...priceRow, quantityOnHand: null }], more: false }));
    await runTurn('set ghee to 89.50', deps);
    expect(writes.stage).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the row version is missing', async () => {
    const { deps, writes, lookup } = priceDeps();
    lookup.mockResolvedValue(ok({ rows: [{ ...ROW, productId: PRODUCT_A }], more: false }));
    expect(await runTurn('set ghee to 89.50', deps)).toEqual({ type: 'refusal', code: 'DATA_UNAVAILABLE' });
    expect(writes.stage).not.toHaveBeenCalled();
  });

  it('asks which product when the name matches several, then stages with the chosen one', async () => {
    const { deps, writes, lookup } = priceDeps();
    const other = { ...priceRow, productId: '55555555-5555-4555-8555-555555555555', name: 'Ghee 1kg' };
    lookup.mockResolvedValue(ok({ rows: [priceRow, other], more: false }));
    const res = await runTurn('set ghee to 89.50', deps);
    expect(res).toMatchObject({ type: 'choose-products', kind: 'product.price' });
    expect(writes.stage).not.toHaveBeenCalled();
    if (res.type !== 'choose-products') throw new Error('expected a choice');
    await runBatchChoice(res.pending, 0, other.productId, deps);
    expect(writes.stage).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ product_id: other.productId, price: 89.5 })] })
    );
  });

  const preview: PreviewReply = {
    type: 'preview',
    kind: 'product.price',
    proposalId: PROPOSAL_ID,
    payloadHash: 'h',
    expiresInSeconds: 120,
    items: [PRICE_ITEM],
  };

  it('on approval applies the approved prices, then shows the SERVER verdict, not the client result', async () => {
    const verdict = { ...PRICE_ITEM, result: 'applied' as const };
    const applyPrices = vi.fn().mockResolvedValue(ok({ ok: true, status: 'executed', items: [verdict] }));
    const approve = vi.fn().mockResolvedValue(ok({ ok: true, status: 'executing', items: [PRICE_ITEM] }));
    const { writes } = priceDeps({ approve, applyPrices });
    const res = await runApproval(preview, 'approver-1', 'ticket-1', { writes });
    expect(applyPrices).toHaveBeenCalledWith(PROPOSAL_ID, [PRICE_ITEM]);
    expect(res).toEqual({ type: 'outcome', kind: 'product.price', status: 'executed', items: [verdict] });
  });

  it('reports a partial verdict from the server', async () => {
    const stale = { ...PRICE_ITEM, result: 'stale' as const };
    const applyPrices = vi.fn().mockResolvedValue(ok({ ok: true, status: 'partial', items: [stale] }));
    const approve = vi.fn().mockResolvedValue(ok({ ok: true, status: 'executing', items: [PRICE_ITEM] }));
    const { writes } = priceDeps({ approve, applyPrices });
    expect(await runApproval(preview, 'a', 't', { writes })).toMatchObject({ status: 'partial' });
  });

  it('writes nothing when the approval is refused', async () => {
    const applyPrices = vi.fn();
    const approve = vi.fn().mockResolvedValue(err({ code: 'INVALID_APPROVAL' }));
    const { writes } = priceDeps({ approve, applyPrices });
    expect(await runApproval(preview, 'a', 't', { writes })).toEqual({ type: 'refusal', code: 'INVALID_APPROVAL' });
    expect(applyPrices).not.toHaveBeenCalled();
  });

  it('says the result is unconfirmed when the server verification does not come back', async () => {
    const applyPrices = vi.fn().mockResolvedValue(err({ code: 'DATA_UNAVAILABLE' }));
    const approve = vi.fn().mockResolvedValue(ok({ ok: true, status: 'executing', items: [PRICE_ITEM] }));
    const { writes } = priceDeps({ approve, applyPrices });
    expect(await runApproval(preview, 'a', 't', { writes })).toEqual({ type: 'refusal', code: 'RESULT_UNCONFIRMED' });
  });

  it('never applies prices when the server answers executed for a price proposal (unexpected status)', async () => {
    const applyPrices = vi.fn();
    const approve = vi.fn().mockResolvedValue(ok({ ok: true, status: 'executed', items: [PRICE_ITEM] }));
    const { writes } = priceDeps({ approve, applyPrices });
    expect(await runApproval(preview, 'a', 't', { writes })).toEqual({ type: 'refusal', code: 'EXECUTION_FAILED' });
    expect(applyPrices).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plan 29-05: cool-down gate before every turn (D-15)
// ---------------------------------------------------------------------------
describe('cool-down gate', () => {
  beforeEach(() => { resetGatewayState(); });

  it('a locked assistant refuses a READ turn with the unlock time and calls neither the model nor any read', async () => {
    const until = '2026-11-08T18:30:00Z';
    const made = makeWriteDeps(LOOKUP, { gate: vi.fn().mockResolvedValue(ok({ ok: true, locked: true, until })) });
    expect(await runTurn('price of ghee', made.deps)).toEqual({ type: 'refusal', code: 'ASSISTANT_LOCKED', until });
    expect(made.propose).not.toHaveBeenCalled();
    expect(made.lookup).not.toHaveBeenCalled();
    expect(made.writes.recordRejection).not.toHaveBeenCalled();
  });

  it('a gate that cannot be read fails closed with DATA_UNAVAILABLE (not unlocked), before the model', async () => {
    const made = makeWriteDeps(LOOKUP, { gate: vi.fn().mockResolvedValue(err({ code: 'DATA_UNAVAILABLE' })) });
    expect(await runTurn('price of ghee', made.deps)).toEqual({ type: 'refusal', code: 'DATA_UNAVAILABLE' });
    expect(made.propose).not.toHaveBeenCalled();
    expect(made.lookup).not.toHaveBeenCalled();
  });

  it('an unlocked gate lets the read through', async () => {
    const made = makeWriteDeps(LOOKUP);
    expect(await runTurn('price of ghee', made.deps)).toMatchObject({ type: 'result', kind: 'product.lookup' });
    expect(made.writes.gate).toHaveBeenCalledTimes(1);
  });

  it('the refusal that trips the lock (5th) tells the panel at once through onLocked', async () => {
    const onLocked = vi.fn();
    const recordRejection = vi.fn().mockResolvedValue(ok({ ok: true, locked: true, until: '2026-11-08T18:40:00Z' }));
    const made = makeWriteDeps('{"kind":"refuse","reason":"unsafe"}', { recordRejection }, { onLocked });
    await runTurn('do bad things', made.deps);
    await vi.waitFor(() => { expect(onLocked).toHaveBeenCalledWith('2026-11-08T18:40:00Z'); });
  });

  it('a refusal that did not trip the lock leaves onLocked alone', async () => {
    const onLocked = vi.fn();
    const recordRejection = vi.fn().mockResolvedValue(ok({ ok: true, locked: false }));
    const made = makeWriteDeps('{"kind":"refuse","reason":"unsafe"}', { recordRejection }, { onLocked });
    await runTurn('do bad things', made.deps);
    await Promise.resolve();
    expect(recordRejection).toHaveBeenCalledTimes(1);
    expect(onLocked).not.toHaveBeenCalled();
  });
});

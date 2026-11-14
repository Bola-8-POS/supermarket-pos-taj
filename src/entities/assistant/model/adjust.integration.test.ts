/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { stageProposal } from './rpc';
import { MODEL, TERMINAL, createAssistantFixtures, skip, type TestStaff } from '../../../test/assistant-fixtures';

/**
 * Integration test: staging validation and atomic execution of assistant stock batches (migration 20261108000002).
 * Stage-time refusals are coded, audited as assistant.denied and leave stock untouched; a 25-item batch whose last
 * item went stale after staging fails as a whole and changes nothing.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321).
 * Run: npx vitest run --project integration src/entities/assistant/model/adjust.integration.test.ts
 * The default role matrix is used here (a cashier holds no adjust_inventory). A skip or setup abort is NOT VERIFIED (L48).
 */
const MIGRATION = '20261108000002';

describe.skipIf(skip)(`assistant stock batches (${MIGRATION})`, () => {
  const fx = createAssistantFixtures('__asst_adj__');
  let cashier: TestStaff;
  let manager: TestStaff;

  beforeAll(async () => {
    cashier = await fx.newStaff('cashier');
    manager = await fx.newStaff('manager');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const deniedCodes = async (who: TestStaff): Promise<string[]> =>
    (await fx.auditRows(who.id)).filter(r => r.action === 'assistant.denied').map(r => r.after.code);

  it(`a role without adjust_inventory is refused at stage: AUTH_FORBIDDEN and an assistant.denied row (${MIGRATION})`, async () => {
    const productId = await fx.addProduct('forbidden', 10);
    const res = await fx.stage(cashier, [fx.adjustItem(productId, -2, 10)]);
    expect(res).toEqual({ ok: false, code: 'AUTH_FORBIDDEN' });
    expect(await fx.qty(productId)).toBe(10);
    expect(await deniedCodes(cashier)).toEqual(['AUTH_FORBIDDEN']);
    expect((await fx.db.from('assistant_proposals').select('id').eq('requester_id', cashier.id)).data).toEqual([]);
    const viaWrapper = await stageProposal(
      {
        kind: 'inventory.adjust',
        reason: 'waste',
        items: [fx.adjustItem(productId, -2, 10)],
        terminalId: TERMINAL,
        model: MODEL,
        policyVersion: 'p',
        promptVersion: 'q',
        rawText: 'write off',
      },
      cashier.client
    );
    expect(!viaWrapper.ok && viaWrapper.error.code).toBe('AUTH_FORBIDDEN');
    await fx.resetCooldown(cashier);
  });

  it(`26 items are refused at stage: TOO_MANY_ITEMS (${MIGRATION})`, async () => {
    const items = Array.from({ length: 26 }, () => fx.adjustItem(randomUUID(), -1, 5));
    expect(await fx.stage(manager, items)).toEqual({ ok: false, code: 'TOO_MANY_ITEMS' });
    expect((await fx.db.from('assistant_proposals').select('id').eq('requester_id', manager.id)).data).toEqual([]);
    await fx.resetCooldown(manager);
  });

  it(`a stale expected_quantity is refused at stage: STALE_TARGET (${MIGRATION})`, async () => {
    const productId = await fx.addProduct('stale', 10);
    expect(await fx.stage(manager, [fx.adjustItem(productId, -2, 9)])).toEqual({ ok: false, code: 'STALE_TARGET' });
    expect(await fx.qty(productId)).toBe(10);
    await fx.resetCooldown(manager);
  });

  it(`an unknown product and a product without a stock row are refused: NOT_FOUND (${MIGRATION})`, async () => {
    expect(await fx.stage(manager, [fx.adjustItem(randomUUID(), -1, 5)])).toEqual({ ok: false, code: 'NOT_FOUND' });
    const noStock = await fx.db
      .from('products')
      .insert({ name: `__asst_adj__nostock ${Date.now()}`, category_id: (await fx.db.from('categories').select('id').limit(1).single()).data.id, base_price: 3, is_active: true, sold_by_weight: false })
      .select('id')
      .single();
    expect(noStock.error).toBeNull();
    try {
      expect(await fx.stage(manager, [fx.adjustItem(noStock.data.id, -1, 0)])).toEqual({ ok: false, code: 'NOT_FOUND' });
    } finally {
      await fx.db.from('products').delete().eq('id', noStock.data.id);
    }
    await fx.resetCooldown(manager);
  });

  it(`malformed batches are refused at stage: INVALID_PROPOSAL and nothing is stored (${MIGRATION})`, async () => {
    const p = await fx.addProduct('invalid', 10);
    const cases: [string, unknown, Record<string, unknown>][] = [
      ['empty batch', [], {}],
      ['not an array', { product_id: p }, {}],
      ['zero delta', [fx.adjustItem(p, 0, 10)], {}],
      ['delta beyond 9999', [fx.adjustItem(p, -10000, 10)], {}],
      ['fractional delta', [{ product_id: p, delta: -1.5, expected_quantity: 10 }], {}],
      ['drives stock below zero', [fx.adjustItem(p, -11, 10)], {}],
      ['duplicate product', [fx.adjustItem(p, -1, 10), fx.adjustItem(p, -2, 10)], {}],
      ['bad product id', [{ product_id: 'nope', delta: -1, expected_quantity: 10 }], {}],
      ['unknown reason', [fx.adjustItem(p, -1, 10)], { p_reason: 'theft' }],
      ['bad terminal id', [fx.adjustItem(p, -1, 10)], { p_terminal_id: 'bad terminal!' }],
      ['unknown kind', [fx.adjustItem(p, -1, 10)], { p_kind: 'inventory.delete' }],
      ['blank raw text', [fx.adjustItem(p, -1, 10)], { p_raw_text: '   ' }],
      ['raw text over 500 chars', [fx.adjustItem(p, -1, 10)], { p_raw_text: 'x'.repeat(501) }],
    ];
    for (const [name, items, over] of cases) {
      const res = await fx.stage(manager, items, over);
      expect({ name, res }).toEqual({ name, res: { ok: false, code: 'INVALID_PROPOSAL' } });
      await fx.resetCooldown(manager);
    }
    expect(await fx.qty(p)).toBe(10);
    expect((await fx.db.from('assistant_proposals').select('id').eq('requester_id', manager.id)).data).toEqual([]);
  });

  describe('a full batch of 25', () => {
    const ids: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 25; i++) ids.push(await fx.addProduct(`batch${String(i).padStart(2, '0')}`, 10));
    });

    const items = () => ids.map(id => fx.adjustItem(id, -1, 10));

    it(`the 25th item going stale after staging fails the whole batch: STOCK_CHANGED, all 25 inventories unchanged (${MIGRATION})`, async () => {
      const staged = await fx.stage(manager, items());
      expect(staged.ok).toBe(true);
      expect(staged.items).toHaveLength(25);
      // Someone sells one unit of the last item while the preview is open.
      expect((await fx.db.from('inventory').update({ quantity_on_hand: 9 }).eq('product_id', ids[24])).error).toBeNull();
      const t = await fx.ticket(manager, manager.pin);
      const res = await fx.approve(manager, staged, t.approverId, t.approvalId);
      expect(res).toEqual({ ok: false, code: 'STOCK_CHANGED', status: 'failed' });
      for (let i = 0; i < 24; i++) expect(await fx.qty(ids[i]!)).toBe(10);
      expect(await fx.qty(ids[24]!)).toBe(9);
      const movements = await fx.db.from('stock_movements').select('product_id').in('product_id', ids);
      expect(movements.data).toEqual([]);
      const prop = await fx.db.from('assistant_proposals').select('status, outcome').eq('id', staged.proposal_id).single();
      expect(prop.data).toEqual({ status: 'failed', outcome: { code: 'STOCK_CHANGED' } });
      const actions = (await fx.auditRows(manager.id, staged.proposal_id)).map(r => r.action);
      expect(actions).toEqual(['assistant.staged', 'assistant.approved', 'assistant.failed']);
    });

    it(`the same 25 items execute together once the stock matches: 25 movements, 25 new quantities (${MIGRATION})`, async () => {
      expect((await fx.db.from('inventory').update({ quantity_on_hand: 10 }).eq('product_id', ids[24])).error).toBeNull();
      const staged = await fx.stage(manager, items());
      expect(staged.ok).toBe(true);
      const t = await fx.ticket(manager, manager.pin);
      const res = await fx.approve(manager, staged, t.approverId, t.approvalId);
      expect(res).toMatchObject({ ok: true, status: 'executed' });
      expect(res.items).toHaveLength(25);
      for (const id of ids) expect(await fx.qty(id)).toBe(9);
      const movements = await fx.db.from('stock_movements').select('product_id, reason').in('product_id', ids);
      expect(movements.data).toHaveLength(25);
      expect(new Set(movements.data.map((m: any) => m.reason))).toEqual(new Set(['waste']));
    });
  });

  describe('price batches (contract carried for Plan 29-05)', () => {
    const priceItem = async (productId: string, price: number) => {
      const row = (await fx.db.from('products').select('base_price, updated_at').eq('id', productId).single()).data;
      return { product_id: productId, price, expected_price: Number(row.base_price), expected_updated_at: row.updated_at };
    };
    const stagePrice = (items: unknown) => fx.stage(manager, items, { p_kind: 'product.price', p_reason: null });

    it(`stage, approve with a manage_products ticket and finish: the server verifies the applied prices (${MIGRATION})`, async () => {
      const a = await fx.addProduct('price a', 5);
      const b = await fx.addProduct('price b', 5);
      const staged = await stagePrice([await priceItem(a, 15), await priceItem(b, 20)]);
      expect(staged.ok).toBe(true);
      expect(staged.items.map((i: any) => [i.before, i.after])).toEqual([[12.5, 15], [12.5, 20]]);
      const t = await fx.ticket(manager, manager.pin, 'manage_products');
      // A ticket for another action is refused first.
      const wrong = await fx.ticket(manager, manager.pin);
      expect(await fx.approve(manager, staged, wrong.approverId, wrong.approvalId)).toEqual({ ok: false, code: 'INVALID_APPROVAL' });
      const approved = await fx.approve(manager, staged, t.approverId, t.approvalId);
      expect(approved).toMatchObject({ ok: true, status: 'executing' });
      // The client applies only the first price; the server reads the truth from products.
      expect((await fx.db.from('products').update({ base_price: 15 }).eq('id', a)).error).toBeNull();
      const finished = await fx.rpc(manager.client, 'assistant_finish', { p_proposal_id: staged.proposal_id, p_outcome: {} });
      expect(finished.status).toBe('partial');
      expect(finished.items.map((i: any) => i.result)).toEqual(['applied', 'stale']);
      const actions = (await fx.auditRows(manager.id, staged.proposal_id)).map(r => r.action);
      // The wrong-action ticket left one assistant.denied row between staging and approval.
      expect(actions).toEqual(['assistant.staged', 'assistant.denied', 'assistant.approved', 'assistant.partial']);
      // A finished proposal cannot be finished again.
      expect(await fx.rpc(manager.client, 'assistant_finish', { p_proposal_id: staged.proposal_id, p_outcome: {} })).toEqual({ ok: false, code: 'ALREADY_USED' });
      await fx.resetCooldown(manager);
    });

    it(`a changed price or updated_at after staging is refused: STALE_TARGET; a price over 100000 is INVALID_PROPOSAL (${MIGRATION})`, async () => {
      const p = await fx.addProduct('price stale', 5);
      const item = await priceItem(p, 15);
      expect((await fx.db.from('products').update({ base_price: 13 }).eq('id', p)).error).toBeNull();
      expect(await stagePrice([item])).toEqual({ ok: false, code: 'STALE_TARGET' });
      const fresh = await priceItem(p, 100001);
      expect(await stagePrice([fresh])).toEqual({ ok: false, code: 'INVALID_PROPOSAL' });
      await fx.resetCooldown(manager);
    });
  });
});

/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The price executor is the feature's code; this test drives the real function against dev2 (test-only import).
import { applyPriceBatch, priceIo } from '../../../features/assistant/model/applyPriceBatch';
import { finishProposal } from './rpc';
import { createAssistantFixtures, skip, type TestStaff } from '../../../test/assistant-fixtures';

/**
 * Integration test: the assistant price write on dev2. The stage / approve / finish contract is migration
 * 20261108000002; the authority for the write itself is products_update_manager_admin in 20260510000001 (RLS needs
 * manage_products). No migration belongs to Plan 29-05: the prices go through the ordinary products UPDATE.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321).
 * Run: npx vitest run --project integration src/entities/assistant/model/price.integration.test.ts
 * A skip or a setup abort is NOT VERIFIED (L48).
 */
const CONTRACT = '20261108000002';
const RLS = '20260510000001';

describe.skipIf(skip)(`assistant price write (${CONTRACT}, ${RLS})`, () => {
  const fx = createAssistantFixtures('__asst_price__');
  let cashier: TestStaff;
  let manager: TestStaff;

  beforeAll(async () => {
    cashier = await fx.newStaff('cashier');
    manager = await fx.newStaff('manager');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const product = async (id: string) => {
    const { data, error } = await fx.db.from('products').select('base_price, updated_at, name').eq('id', id).single();
    if (error) throw new Error(`product read: ${error.message}`);
    return data as { base_price: number; updated_at: string; name: string };
  };

  /** Stage a price batch as `who`: items are [productId, newPrice]; the expected values come from the live rows. */
  async function stagePrices(who: TestStaff, items: [string, number][]) {
    const rows = [];
    for (const [id, price] of items) {
      const cur = await product(id);
      rows.push({ product_id: id, price, expected_price: cur.base_price, expected_updated_at: cur.updated_at });
    }
    return fx.stage(who, rows, { p_kind: 'product.price', p_reason: 'price_change', p_raw_text: 'cambia el precio del ghee a 89.50' });
  }

  async function approveAs(who: TestStaff, approver: TestStaff, staged: any) {
    const t = await fx.ticket(who, approver.pin, 'manage_products');
    return fx.approve(who, staged, t.approverId, t.approvalId);
  }

  it(`RLS (${RLS}): a cashier's own products UPDATE changes nothing; the stage refuses with AUTH_FORBIDDEN (${CONTRACT})`, async () => {
    const held = await fx.db.from('role_permissions').select('role').eq('role', 'cashier').eq('action', 'manage_products');
    expect(held.data).toEqual([]);
    const id = await fx.addProduct('rls', 5);
    const before = await product(id);

    const upd = await cashier.client.from('products').update({ base_price: 99 }).eq('id', id).select('id');
    expect(upd.error).toBeNull();
    expect(upd.data).toEqual([]);
    expect((await product(id)).base_price).toBe(before.base_price);

    const staged = await stagePrices(cashier, [[id, 99]]);
    expect(staged).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
    const rows = await fx.auditRows(cashier.id);
    expect(rows.map(r => r.action)).toContain('assistant.denied');
  });

  it(`manager stages, a manager PIN approves, the CAS update applies, finish verifies and audits (${CONTRACT})`, async () => {
    const id = await fx.addProduct('ghee', 5);
    const staged = await stagePrices(manager, [[id, 89.5]]);
    expect(staged.ok).toBe(true);
    expect(staged.items).toEqual([expect.objectContaining({ product_id: id, before: 12.5, after: 89.5 })]);
    expect(staged.items[0].expected_updated_at).toEqual(expect.any(String));

    const approved = await approveAs(manager, manager, staged);
    expect(approved).toMatchObject({ ok: true, status: 'executing' });
    expect((await product(id)).base_price).toBe(12.5);

    const done = await applyPriceBatch(staged.proposal_id, approved.items, priceIo(manager.client));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data.status).toBe('executed');
    expect(done.data.items).toEqual([expect.objectContaining({ product_id: id, before: 12.5, after: 89.5, result: 'applied' })]);
    expect((await product(id)).base_price).toBe(89.5);

    const rows = await fx.auditRows(manager.id, staged.proposal_id);
    expect(rows.map(r => r.action)).toEqual(['assistant.staged', 'assistant.approved', 'assistant.executed']);
    expect(rows[2].after.items).toEqual([expect.objectContaining({ result: 'applied', after: 89.5 })]);
    const prop = await fx.db.from('assistant_proposals').select('status, kind').eq('id', staged.proposal_id).single();
    expect(prop.data).toMatchObject({ status: 'executed', kind: 'product.price' });
  });

  it(`a cashier request cannot even be staged; a manager PIN does not lend its authority to the cashier (${CONTRACT})`, async () => {
    const id = await fx.addProduct('cashier-ghee', 5);
    const staged = await stagePrices(cashier, [[id, 50]]);
    expect(staged).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
    expect((await product(id)).base_price).toBe(12.5);
  });

  it(`partial batch: an item edited by someone else is stale (not overwritten); the others apply; finish says partial (${CONTRACT})`, async () => {
    const a = await fx.addProduct('p-a', 5);
    const b = await fx.addProduct('p-b', 5);
    const c = await fx.addProduct('p-c', 5);
    const staged = await stagePrices(manager, [[a, 21], [b, 22], [c, 23]]);
    expect(staged.ok).toBe(true);
    const approved = await approveAs(manager, manager, staged);
    expect(approved.ok).toBe(true);

    // Someone edits item b after the approval (a field that is not the price, so the price still equals "before").
    const edit = await fx.db.from('products').update({ name: 'renamed by someone else' }).eq('id', b);
    expect(edit.error).toBeNull();

    const done = await applyPriceBatch(staged.proposal_id, approved.items, priceIo(manager.client));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data.status).toBe('partial');
    expect(done.data.items.map(i => [i.product_id, i.result])).toEqual([[a, 'applied'], [b, 'stale'], [c, 'applied']]);
    expect((await product(a)).base_price).toBe(21);
    expect((await product(b)).base_price).toBe(12.5);
    expect((await product(c)).base_price).toBe(23);
    const rows = await fx.auditRows(manager.id, staged.proposal_id);
    expect(rows.at(-1)?.action).toBe('assistant.partial');
  });

  it(`finish records mismatch when the live price is neither the old nor the approved one, and never believes the client (${CONTRACT})`, async () => {
    const a = await fx.addProduct('m-a', 5);
    const b = await fx.addProduct('m-b', 5);
    const staged = await stagePrices(manager, [[a, 31], [b, 32]]);
    const approved = await approveAs(manager, manager, staged);
    expect(approved.ok).toBe(true);

    // Apply a for real; b is changed by someone else to a third price. The client then CLAIMS both were applied.
    const first = await manager.client
      .from('products')
      .update({ base_price: 31 })
      .eq('id', a)
      .eq('updated_at', approved.items[0].expected_updated_at)
      .select('id');
    expect(first.data).toHaveLength(1);
    await fx.db.from('products').update({ base_price: 7.77 }).eq('id', b);

    const verdict = await finishProposal(
      staged.proposal_id,
      { items: [{ product_id: a, result: 'applied' }, { product_id: b, result: 'applied' }] },
      manager.client
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.data.status).toBe('partial');
    expect(verdict.data.items.map(i => [i.product_id, i.result])).toEqual([[a, 'applied'], [b, 'mismatch']]);
  });

  it(`a finished proposal cannot be finished again, and another user cannot finish it (${CONTRACT})`, async () => {
    const id = await fx.addProduct('once', 5);
    const staged = await stagePrices(manager, [[id, 40]]);
    const approved = await approveAs(manager, manager, staged);
    const done = await applyPriceBatch(staged.proposal_id, approved.items, priceIo(manager.client));
    expect(done.ok).toBe(true);
    expect(await finishProposal(staged.proposal_id, { items: [] }, manager.client)).toMatchObject({
      ok: false,
      error: { code: 'ALREADY_USED' },
    });
    expect(await finishProposal(staged.proposal_id, { items: [] }, cashier.client)).toMatchObject({
      ok: false,
      error: { code: 'NOT_OWNER' },
    });
  });

  it(`stage refuses a stale expected price and an out-of-range price (${CONTRACT})`, async () => {
    await fx.resetCooldown(manager);
    const id = await fx.addProduct('guard', 5);
    const cur = await product(id);
    const stale = await fx.stage(
      manager,
      [{ product_id: id, price: 20, expected_price: 99, expected_updated_at: cur.updated_at }],
      { p_kind: 'product.price', p_reason: 'price_change' }
    );
    expect(stale).toMatchObject({ ok: false, code: 'STALE_TARGET' });
    for (const price of [0, 100000.01]) {
      const bad = await fx.stage(
        manager,
        [{ product_id: id, price, expected_price: cur.base_price, expected_updated_at: cur.updated_at }],
        { p_kind: 'product.price', p_reason: 'price_change' }
      );
      expect(bad).toMatchObject({ ok: false, code: 'INVALID_PROPOSAL' });
    }
    expect((await product(id)).base_price).toBe(12.5);
  });
});

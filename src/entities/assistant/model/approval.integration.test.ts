/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveProposal, cancelProposal, stageProposal } from './rpc';
import { MODEL, TERMINAL, createAssistantFixtures, skip, type TestStaff } from '../../../test/assistant-fixtures';

/**
 * Integration test: the assistant approval contract (migration 20261108000002) on dev2.
 * A cashier whose role holds adjust_inventory stages a write-off, a manager/admin PIN ticket approves it, and the
 * server runs it through adjust_inventory. Every binding (actor, payload, terminal, time, single use, ticket action,
 * approver role) has its own refusal case; a refused case leaves the stock exactly as it was.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321).
 * Run: npx vitest run --project integration src/entities/assistant/model/approval.integration.test.ts
 * A skip or a setup abort is NOT VERIFIED (L48).
 */
const MIGRATION = '20261108000002';

describe.skipIf(skip)(`assistant approval (${MIGRATION})`, () => {
  const fx = createAssistantFixtures('__asst_appr__');
  let cashier: TestStaff;
  let otherCashier: TestStaff;
  let manager: TestStaff;
  let admin: TestStaff;

  beforeAll(async () => {
    await fx.grantCashierAdjust();
    cashier = await fx.newStaff('cashier');
    otherCashier = await fx.newStaff('cashier', 'cashier2');
    manager = await fx.newStaff('manager');
    admin = await fx.newStaff('admin');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  /** One product at `qty`, staged by `who` for a delta of -2; returns the raw stage result. */
  async function stageOne(who: TestStaff, qty = 10, delta = -2) {
    const productId = await fx.addProduct('ghee', qty);
    const staged = await fx.stage(who, [fx.adjustItem(productId, delta, qty)]);
    expect(staged.ok).toBe(true);
    return { productId, staged };
  }

  it(`cashier stages one write-off, a manager PIN approves, the server applies it and audits it (${MIGRATION})`, async () => {
    const productId = await fx.addProduct('ghee', 10);
    const staged = await stageProposal(
      {
        kind: 'inventory.adjust',
        reason: 'waste',
        items: [fx.adjustItem(productId, -2, 10)],
        terminalId: TERMINAL,
        model: MODEL,
        policyVersion: 'it-policy',
        promptVersion: 'it-prompt',
        rawText: 'write off 2 ghee, expired',
      },
      cashier.client
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.data.items).toEqual([expect.objectContaining({ product_id: productId, before: 10, after: 8 })]);
    expect(staged.data.expires_in_seconds).toBe(120);

    const t = await fx.ticket(cashier, manager.pin);
    expect(t.approverId).toBe(manager.id);
    const approved = await approveProposal(
      {
        proposalId: staged.data.proposal_id,
        payloadHash: staged.data.payload_hash,
        approvalId: t.approvalId,
        approverId: t.approverId,
        terminalId: TERMINAL,
      },
      cashier.client
    );
    expect(approved.ok && approved.data.status).toBe('executed');
    expect(await fx.qty(productId)).toBe(8);

    const rows = await fx.auditRows(cashier.id, staged.data.proposal_id);
    expect(rows.map(r => r.action)).toEqual(['assistant.staged', 'assistant.approved', 'assistant.executed']);
    for (const r of rows) {
      expect(r.source).toBe('rpc');
      expect(r.after.origin).toBe('local_assistant');
    }
    expect(rows[1].after).toMatchObject({ requester_id: cashier.id, approver_id: manager.id, self_approved: false });
    expect(rows[2].after.items).toEqual([expect.objectContaining({ before: 10, after: 8 })]);

    const text = await fx.db.from('assistant_proposal_texts').select('raw_text').eq('proposal_id', staged.data.proposal_id).single();
    expect(text.data.raw_text).toBe('write off 2 ghee, expired');
    const prop = await fx.db.from('assistant_proposals').select('status, approver_id, requester_id, model').eq('id', staged.data.proposal_id).single();
    expect(prop.data).toMatchObject({ status: 'executed', approver_id: manager.id, requester_id: cashier.id, model: MODEL });
    const mv = await fx.db.from('stock_movements').select('quantity_delta, reason, staff_id').eq('product_id', productId);
    expect(mv.data).toEqual([{ quantity_delta: -2, reason: 'waste', staff_id: cashier.id }]);
  });

  it(`an admin PIN approves a cashier request too (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(cashier, admin.pin);
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId);
    expect(res).toMatchObject({ ok: true, status: 'executed' });
    expect(await fx.qty(productId)).toBe(8);
  });

  it(`a manager approves their own request with their own PIN; the audit row records requester = approver (D-13, ${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(manager);
    const t = await fx.ticket(manager, manager.pin);
    expect(t.approverId).toBe(manager.id);
    const res = await fx.approve(manager, staged, t.approverId, t.approvalId);
    expect(res).toMatchObject({ ok: true, status: 'executed' });
    expect(await fx.qty(productId)).toBe(8);
    const approvedRow = (await fx.auditRows(manager.id, staged.proposal_id)).find(r => r.action === 'assistant.approved');
    expect(approvedRow.after).toMatchObject({ requester_id: manager.id, approver_id: manager.id, self_approved: true });
    const prop = await fx.db.from('assistant_proposals').select('approver_id, requester_id').eq('id', staged.proposal_id).single();
    expect(prop.data.approver_id).toBe(prop.data.requester_id);
  });

  it(`another user's session cannot approve the proposal: NOT_OWNER, stock unchanged (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(otherCashier, manager.pin);
    const res = await fx.approve(otherCashier, staged, t.approverId, t.approvalId);
    expect(res).toEqual({ ok: false, code: 'NOT_OWNER' });
    expect(await fx.qty(productId)).toBe(10);
    await fx.resetCooldown(otherCashier);
  });

  it(`a changed payload hash is refused: PAYLOAD_MISMATCH, stock unchanged (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(cashier, manager.pin);
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId, { p_payload_hash: 'f'.repeat(64) });
    expect(res).toEqual({ ok: false, code: 'PAYLOAD_MISMATCH' });
    expect(await fx.qty(productId)).toBe(10);
    // The ticket was not consumed by the refusal: the same proposal still approves with the right hash.
    expect(await fx.approve(cashier, staged, t.approverId, t.approvalId)).toMatchObject({ ok: true, status: 'executed' });
  });

  it(`another terminal is refused: TERMINAL_MISMATCH, stock unchanged (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(cashier, manager.pin);
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId, { p_terminal_id: 'OTHER-TILL' });
    expect(res).toEqual({ ok: false, code: 'TERMINAL_MISMATCH' });
    expect(await fx.qty(productId)).toBe(10);
  });

  it(`a preview older than its 2 minutes is refused: PROPOSAL_EXPIRED, an assistant.expired row, stock unchanged (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await fx.db.from('assistant_proposals').update({ expires_at: past }).eq('id', staged.proposal_id)).error).toBeNull();
    const t = await fx.ticket(cashier, manager.pin);
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId);
    expect(res).toEqual({ ok: false, code: 'PROPOSAL_EXPIRED' });
    expect(await fx.qty(productId)).toBe(10);
    const rows = await fx.auditRows(cashier.id, staged.proposal_id);
    expect(rows.map(r => r.action)).toContain('assistant.expired');
    const prop = await fx.db.from('assistant_proposals').select('status').eq('id', staged.proposal_id).single();
    expect(prop.data.status).toBe('expired');
  });

  it(`a replayed or second confirm of an executed proposal is refused: ALREADY_USED, stock applied once (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(cashier, manager.pin);
    expect(await fx.approve(cashier, staged, t.approverId, t.approvalId)).toMatchObject({ ok: true });
    const t2 = await fx.ticket(cashier, manager.pin);
    const second = await fx.approve(cashier, staged, t2.approverId, t2.approvalId);
    expect(second).toEqual({ ok: false, code: 'ALREADY_USED' });
    expect(await fx.qty(productId)).toBe(8);
    await fx.resetCooldown(cashier);
  });

  it(`a consumed ticket cannot approve a second proposal: INVALID_APPROVAL (${MIGRATION})`, async () => {
    const first = await stageOne(cashier);
    const t = await fx.ticket(cashier, manager.pin);
    expect(await fx.approve(cashier, first.staged, t.approverId, t.approvalId)).toMatchObject({ ok: true });
    const second = await stageOne(cashier);
    const res = await fx.approve(cashier, second.staged, t.approverId, t.approvalId);
    expect(res).toEqual({ ok: false, code: 'INVALID_APPROVAL' });
    expect(await fx.qty(second.productId)).toBe(10);
  });

  it(`a ticket issued for manage_products cannot approve a stock proposal: INVALID_APPROVAL (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const t = await fx.ticket(cashier, manager.pin, 'manage_products');
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId);
    expect(res).toEqual({ ok: false, code: 'INVALID_APPROVAL' });
    expect(await fx.qty(productId)).toBe(10);
  });

  it(`a cashier PIN cannot approve even when the matrix lets cashiers hold adjust_inventory: APPROVER_NOT_MANAGER (D-12, ${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    // otherCashier's role holds adjust_inventory (matrix edit), so verify_staff_pin itself issues the ticket.
    const t = await fx.ticket(cashier, otherCashier.pin);
    expect(t.approverId).toBe(otherCashier.id);
    const res = await fx.approve(cashier, staged, t.approverId, t.approvalId);
    expect(res).toEqual({ ok: false, code: 'APPROVER_NOT_MANAGER' });
    expect(await fx.qty(productId)).toBe(10);
    await fx.resetCooldown(cashier);
  });

  it(`a requester who lost adjust_inventory after staging is refused at approve: AUTH_FORBIDDEN (${MIGRATION})`, async () => {
    const lone = await fx.newStaff('cashier', 'cashier3');
    const { productId, staged } = await stageOne(lone);
    const t = await fx.ticket(lone, manager.pin);
    const revoke = await fx.db.from('role_permissions').delete().eq('role', 'cashier').eq('action', 'adjust_inventory');
    expect(revoke.error).toBeNull();
    try {
      const res = await fx.approve(lone, staged, t.approverId, t.approvalId);
      expect(res).toEqual({ ok: false, code: 'AUTH_FORBIDDEN' });
      expect(await fx.qty(productId)).toBe(10);
    } finally {
      expect((await fx.db.from('role_permissions').insert({ role: 'cashier', action: 'adjust_inventory' })).error).toBeNull();
    }
  });

  it(`cancel ends a staged proposal; it then cannot be approved (${MIGRATION})`, async () => {
    const { productId, staged } = await stageOne(cashier);
    const cancelled = await cancelProposal(staged.proposal_id, 'user', cashier.client);
    expect(cancelled.ok && cancelled.data.status).toBe('cancelled');
    const t = await fx.ticket(cashier, manager.pin);
    expect(await fx.approve(cashier, staged, t.approverId, t.approvalId)).toEqual({ ok: false, code: 'ALREADY_USED' });
    expect(await fx.qty(productId)).toBe(10);
    await fx.resetCooldown(cashier);
  });
});

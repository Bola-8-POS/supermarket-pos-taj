/* eslint-disable */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { recordRejection } from './rpc';
import { anonKey, createAssistantFixtures, skip, url, type TestStaff } from '../../../test/assistant-fixtures';

/**
 * Integration test: audit trail, admin-only raw text, reserved namespace, cool-down and fence triggers of the
 * assistant write contract (migration 20261108000002). Server-side only: nothing here trusts the client.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321); the
 * trigger test also needs `psql` on PATH (dev2 Postgres at 127.0.0.1:56322). A skip or setup abort is NOT VERIFIED (L48).
 * Run: npx vitest run --project integration src/entities/assistant/model/audit.integration.test.ts
 */
const MIGRATION = '20261108000002';
const DEV2_DB = 'postgresql://postgres:postgres@127.0.0.1:56322/postgres?sslmode=disable';

describe.skipIf(skip)(`assistant audit, secrecy and cool-down (${MIGRATION})`, () => {
  const fx = createAssistantFixtures('__asst_aud__');
  let manager: TestStaff;
  let admin: TestStaff;
  let cashier: TestStaff;
  const stamp = String(Date.now());

  beforeAll(async () => {
    manager = await fx.newStaff('manager');
    admin = await fx.newStaff('admin');
    cashier = await fx.newStaff('cashier');
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  const auditCount = async (actorId: string, like: string): Promise<number> => {
    const { count, error } = await fx.db
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('actor_id', actorId)
      .like('action', like);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  it(`record_audit from a signed-in client inserts nothing in the reserved assistant namespace (${MIGRATION})`, async () => {
    const reserved = ['assistant.executed', 'assistant.locked', 'x.assistant_y', 'assistant_executed', 'Assistant.executed'];
    for (const action of reserved) {
      const res = await manager.client.rpc('record_audit', { p_action: action, p_entity_type: 'assistant_proposal', p_after: { forged: true } });
      expect(res.error).toBeNull();
      expect(res.data).toBeNull();
    }
    expect(await auditCount(manager.id, '%assistant%')).toBe(0);
    expect(await auditCount(manager.id, '%ssistant%')).toBe(0);
    // Positive control: the function still records an ordinary action for the same caller.
    const ok = await manager.client.rpc('record_audit', { p_action: 'screen.lock', p_entity_type: 'screen' });
    expect(ok.error).toBeNull();
    expect(ok.data).not.toBeNull();
    expect(await auditCount(manager.id, 'screen.lock')).toBe(1);
  });

  it(`a client cannot insert audit_logs rows directly either (${MIGRATION})`, async () => {
    const ins = await manager.client
      .from('audit_logs')
      .insert({ actor_id: manager.id, action: 'assistant.executed', entity_type: 'assistant_proposal', source: 'rpc' });
    expect(ins.error).not.toBeNull();
    // Neither the forged action nor a denial row was written by those calls.
    expect(await auditCount(manager.id, 'assistant.executed')).toBe(0);
    expect(await auditCount(manager.id, 'assistant.denied')).toBe(0);
  });

  it(`the raw request text is readable by an admin only; a manager selects 0 rows and no client can write either table (D-17, ${MIGRATION})`, async () => {
    const productId = await fx.addProduct('secret', 10);
    const staged = await fx.stage(manager, [fx.adjustItem(productId, -1, 10)], { p_raw_text: 'write off the secret ghee' });
    expect(staged.ok).toBe(true);
    const id = staged.proposal_id as string;

    const asManager = await manager.client.from('assistant_proposal_texts').select('proposal_id, raw_text').eq('proposal_id', id);
    expect(asManager.error).toBeNull();
    expect(asManager.data).toEqual([]);
    const asAdmin = await admin.client.from('assistant_proposal_texts').select('proposal_id, raw_text').eq('proposal_id', id);
    expect(asAdmin.error).toBeNull();
    expect(asAdmin.data).toEqual([{ proposal_id: id, raw_text: 'write off the secret ghee' }]);
    const asAnon = await fx.anon().from('assistant_proposal_texts').select('raw_text').eq('proposal_id', id);
    expect(asAnon.data ?? []).toEqual([]);

    // No text in the audit trail (D-16/D-17).
    const audit = JSON.stringify(await fx.auditRows(manager.id, id));
    expect(audit).not.toContain('secret ghee');

    for (const client of [manager.client, admin.client, cashier.client]) {
      expect((await client.from('assistant_proposal_texts').insert({ proposal_id: id, raw_text: 'forged' })).error).not.toBeNull();
      expect((await client.from('assistant_proposals').insert({ requester_id: manager.id, kind: 'inventory.adjust', action: 'adjust_inventory', payload: {}, payload_hash: 'x', item_count: 1, terminal_id: 'T', model: 'm', policy_version: 'p', prompt_version: 'q', status: 'executed', expires_at: new Date().toISOString() })).error).not.toBeNull();
    }
    // Updates and deletes by a client change nothing (the table grants nothing to authenticated).
    await manager.client.from('assistant_proposals').update({ status: 'executed' }).eq('id', id);
    await admin.client.from('assistant_proposal_texts').delete().eq('proposal_id', id);
    const stillThere = await fx.db.from('assistant_proposals').select('status').eq('id', id).single();
    expect(stillThere.data.status).toBe('staged');
    expect((await fx.db.from('assistant_proposal_texts').select('raw_text').eq('proposal_id', id)).data).toHaveLength(1);
    // A staff member cannot even read the proposals table directly.
    expect((await manager.client.from('assistant_proposals').select('id').eq('id', id)).error).not.toBeNull();
  });

  it(`an anonymous caller cannot execute any assistant RPC (${MIGRATION})`, async () => {
    const anon = fx.anon();
    for (const [fn, args] of [
      ['assistant_gate', undefined],
      ['assistant_record_rejection', { p_reason: 'x' }],
      ['assistant_cancel', { p_proposal_id: '00000000-0000-4000-8000-000000000000', p_reason: 'user' }],
    ] as const) {
      const res = await anon.rpc(fn, args as any);
      expect({ fn, failed: res.error !== null }).toEqual({ fn, failed: true });
    }
    // The internal helpers are not callable by a signed-in client either.
    // Correct argument lists, so the only reason to fail is the missing EXECUTE grant.
    const internal: [string, Record<string, unknown>][] = [
      ['assistant_audit', { p_action: 'assistant.executed', p_entity_id: null, p_after: {}, p_terminal: 'T1' }],
      ['assistant_reject', { p_action: 'assistant.denied', p_code: 'X', p_kind: null, p_entity_id: null, p_terminal: 'T1' }],
      ['assistant_deny', { p_code: 'X', p_kind: null, p_entity_id: null, p_terminal: 'T1' }],
      ['assistant_lock_state', { p_uid: manager.id }],
    ];
    for (const [fn, args] of internal) {
      const res = await manager.client.rpc(fn, args);
      expect({ fn, failed: res.error !== null }).toEqual({ fn, failed: true });
    }
    // Neither the forged action nor a denial row was written by those calls.
    expect(await auditCount(manager.id, 'assistant.executed')).toBe(0);
    expect(await auditCount(manager.id, 'assistant.denied')).toBe(0);
  });

  it(`an unconfirmed preview is expired by assistant_gate and an executing one that never reported becomes outcome_unknown (${MIGRATION})`, async () => {
    const productId = await fx.addProduct('reconcile', 10);
    const stale = await fx.stage(manager, [fx.adjustItem(productId, -1, 10)]);
    expect(stale.ok).toBe(true);
    await fx.db.from('assistant_proposals').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', stale.proposal_id);

    const p = await fx.addProduct('reconcile price', 5);
    const row = (await fx.db.from('products').select('base_price, updated_at').eq('id', p).single()).data;
    const price = await fx.stage(manager, [{ product_id: p, price: 15, expected_price: Number(row.base_price), expected_updated_at: row.updated_at }], { p_kind: 'product.price', p_reason: null });
    expect(price.ok).toBe(true);
    const t = await fx.ticket(manager, manager.pin, 'manage_products');
    expect(await fx.approve(manager, price, t.approverId, t.approvalId)).toMatchObject({ ok: true, status: 'executing' });
    await fx.db.from('assistant_proposals').update({ approved_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq('id', price.proposal_id);

    const gate = await fx.rpc(manager.client, 'assistant_gate');
    expect(gate).toEqual({ ok: true, locked: false, until: null });
    const rows = await fx.db.from('assistant_proposals').select('id, status').in('id', [stale.proposal_id, price.proposal_id]);
    const byId = Object.fromEntries(rows.data.map((r: any) => [r.id, r.status]));
    expect(byId[stale.proposal_id]).toBe('expired');
    expect(byId[price.proposal_id]).toBe('outcome_unknown');
    expect((await fx.auditRows(manager.id, stale.proposal_id)).map(r => r.action)).toContain('assistant.expired');
    expect((await fx.auditRows(manager.id, price.proposal_id)).map(r => r.action)).toContain('assistant.outcome_unknown');
    expect(await fx.qty(productId)).toBe(10);
  });

  it(`5 client-reported refusals lock the assistant for 10 minutes; stage, approve and gate then say ASSISTANT_LOCKED (D-15, ${MIGRATION})`, async () => {
    const productId = await fx.addProduct('locked', 10);
    const staged = await fx.stage(manager, [fx.adjustItem(productId, -1, 10)]);
    expect(staged.ok).toBe(true);
    const t = await fx.ticket(manager, manager.pin);

    for (let i = 1; i <= 4; i++) {
      const res = await recordRejection('MODEL_REFUSED_UNSAFE', 'refuse', manager.client);
      expect(res.ok && res.data.locked).toBe(false);
    }
    const before = Date.now();
    const fifth = await fx.rpc(manager.client, 'assistant_record_rejection', { p_reason: 'model_refused_unsafe', p_kind: 'refuse' });
    expect(fifth).toMatchObject({ ok: true, locked: true });
    const msLocked = Date.parse(fifth.until) - before;
    expect(msLocked).toBeGreaterThan(9 * 60_000);
    expect(msLocked).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    expect(await auditCount(manager.id, 'assistant.rejected')).toBe(5);
    expect(await auditCount(manager.id, 'assistant.locked')).toBe(1);

    // While locked, nothing more is recorded and everything is refused.
    const again = await fx.rpc(manager.client, 'assistant_record_rejection', { p_reason: 'model_refused_unsafe' });
    expect(again).toMatchObject({ ok: true, locked: true });
    expect(await auditCount(manager.id, 'assistant.rejected')).toBe(5);
    expect(await fx.stage(manager, [fx.adjustItem(productId, -1, 10)])).toMatchObject({ ok: false, code: 'ASSISTANT_LOCKED' });
    expect(await fx.approve(manager, staged, t.approverId, t.approvalId)).toMatchObject({ ok: false, code: 'ASSISTANT_LOCKED' });
    expect(await fx.rpc(manager.client, 'assistant_gate')).toMatchObject({ ok: true, locked: true });
    expect(await fx.qty(productId)).toBe(10);

    // The lock ends by itself: once its time has passed the gate is open again.
    const lockRow = (await fx.db.from('audit_logs').select('id, after').eq('actor_id', manager.id).eq('action', 'assistant.locked').single()).data;
    const expired = { ...lockRow.after, until: new Date(Date.now() - 1000).toISOString() };
    expect((await fx.db.from('audit_logs').update({ after: expired }).eq('id', lockRow.id)).error).toBeNull();
    expect(await fx.rpc(manager.client, 'assistant_gate')).toEqual({ ok: true, locked: false, until: null });
    // The ticket was not spent by the locked refusal, so the same approval still works once unlocked.
    expect(await fx.approve(manager, staged, t.approverId, t.approvalId)).toMatchObject({ ok: true, status: 'executed' });
    await fx.resetCooldown(manager);
  });

  it(`5 server-side denials lock the assistant too, and the shape of a reported refusal is validated (${MIGRATION})`, async () => {
    const productId = await fx.addProduct('denied', 10);
    for (let i = 1; i <= 5; i++) {
      expect(await fx.stage(cashier, [fx.adjustItem(productId, -1, 10)])).toEqual({ ok: false, code: 'AUTH_FORBIDDEN' });
    }
    expect(await auditCount(cashier.id, 'assistant.denied')).toBe(5);
    expect(await auditCount(cashier.id, 'assistant.locked')).toBe(1);
    expect(await fx.stage(cashier, [fx.adjustItem(productId, -1, 10)])).toMatchObject({ ok: false, code: 'ASSISTANT_LOCKED' });
    expect(await auditCount(cashier.id, 'assistant.denied')).toBe(5);

    for (const args of [
      { p_reason: 'BAD CODE' },
      { p_reason: 'x'.repeat(41) },
      { p_reason: 'ok_code', p_kind: 'Bad Kind' },
      { p_reason: 'ok_code', p_kind: 'k'.repeat(41) },
    ]) {
      expect(await fx.rpc(manager.client, 'assistant_record_rejection', args)).toEqual({ ok: false, code: 'INVALID_PROPOSAL' });
    }
    await fx.resetCooldown(cashier);
  });

  it(`a locked assistant does not touch checkout: the existing sale RPC still succeeds for the locked user (${MIGRATION})`, async () => {
    const sale = await fx.addProduct('checkout', 1000);
    const price = 12.5;
    const shift = await fx.db.from('shifts').insert({ staff_id: cashier.id, opening_cash: 0 }).select('id').single();
    expect(shift.error).toBeNull();
    const caja = await fx.db
      .from('caja_sessions')
      .insert({ opened_by: manager.id, opening_cash: 0, terminal_id: `T${stamp.slice(-8)}` })
      .select('id, terminal_id')
      .single();
    expect(caja.error).toBeNull();
    let tabId: string | null = null;
    try {
      for (let i = 0; i < 5; i++) await recordRejection('PAYMENT_DATA', null, cashier.client);
      expect(await fx.rpc(cashier.client, 'assistant_gate')).toMatchObject({ ok: true, locked: true });

      // The real checkout path: the edge function, called with the locked cashier's own token.
      const token = (await cashier.client.auth.getSession()).data.session?.access_token;
      const http = await fetch(`${url}/functions/v1/process-direct-sale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          shiftId: shift.data.id,
          cajaSessionId: caja.data.id,
          items: [{ productId: sale, quantity: 1, unitPrice: price }],
          idempotencyKey: `__asst_aud__${stamp}-${Math.random().toString(36).slice(2, 9)}`,
          method: 'cash',
          amount: price,
          tenderedAmount: price,
          terminalId: caja.data.terminal_id,
        }),
      });
      const res: any = await http.json().catch(() => null);
      expect({ status: http.status, body: res }).toMatchObject({ status: 200 });
      tabId = res?.tabId ?? res?.data?.tabId ?? null;
      expect(tabId).not.toBeNull();
      expect(await fx.qty(sale)).toBe(999);
      expect(await fx.rpc(cashier.client, 'assistant_gate')).toMatchObject({ ok: true, locked: true });
    } finally {
      if (tabId) {
        const paymentIds = (await fx.db.from('payments').select('id').eq('tab_id', tabId)).data?.map((p: any) => p.id) ?? [];
        await fx.db.from('payments').delete().eq('tab_id', tabId).eq('is_refund', true);
        await fx.db.from('refunds').delete().in('original_payment_id', paymentIds);
        await fx.db.from('payments').delete().eq('tab_id', tabId);
        const orderIds = (await fx.db.from('orders').select('id').eq('tab_id', tabId)).data?.map((o: any) => o.id) ?? [];
        await fx.db.from('order_items').delete().in('order_id', orderIds);
        await fx.db.from('orders').delete().eq('tab_id', tabId);
        await fx.db.from('tabs').delete().eq('id', tabId);
      }
      await fx.db.from('stock_movements').delete().eq('product_id', sale);
      const row = (await fx.db.from('caja_sessions').select('version').eq('id', caja.data.id).single()).data;
      await fx.db.from('caja_sessions').update({ status: 'closed', closed_at: new Date().toISOString(), version: (row?.version ?? 0) + 1 }).eq('id', caja.data.id);
      await fx.db.from('caja_sessions').delete().eq('id', caja.data.id);
      await fx.db.from('shifts').delete().eq('id', shift.data.id);
      await fx.resetCooldown(cashier);
    }
  });

  it.skipIf(!url?.includes(':56321'))(`both new tables carry the store_fence_guard trigger (${MIGRATION})`, () => {
    const out = execFileSync(
      'psql',
      [
        '-X', '-A', '-t', '-w',
        '-c',
        "select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'store_fence_guard' and not t.tgisinternal and c.relname in ('assistant_proposals','assistant_proposal_texts') order by 1",
        DEV2_DB,
      ],
      { encoding: 'utf8', timeout: 20_000 }
    );
    expect(out.trim().split(/\r?\n/)).toEqual(['assistant_proposal_texts', 'assistant_proposals']);
  });
});

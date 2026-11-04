// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: process_refund replay safety (offline-first Plan 01,
 * Task 2). Seeds a real paid sale through process_direct_sale_atomic, then
 * refunds it twice (and, in the concurrent case, simultaneously) with the
 * same idempotency key — a byte-identical replay must return the original
 * refund id and must not create a second refunds row, a second negative
 * payments row, or a second real inventory restock.
 *
 * Deviations from the task brief's illustrative test code (documented here
 * since this is the file the deviation lives in):
 *  - process_refund's ProcessRefundInputSchema (src/shared/lib/domain.ts)
 *    shapes each item as { order_item_id, qty, amount, restock } — the
 *    brief's snippet used { orderItemId, quantity }, which the RPC would
 *    read as absent and reject as REFUND_ITEM_INVALID.
 *  - process_refund always requires a valid manager-approval ticket
 *    (resolve_manager_approval returns APPROVAL_REQUIRED and the RPC
 *    RETURNs NULL without ever inserting a refund when p_approval_id is
 *    omitted) — so every call here, including the first replay case, seeds
 *    one via seedManagerApproval() even though the brief's first test case
 *    omitted it.
 *  - process_direct_sale_atomic is granted to postgres/service_role only
 *    (confirmed via information_schema.routine_privileges on dev2), not to
 *    authenticated — seedPaidSale() below calls it via testDb (service-role
 *    client), not the signed-in `supabase` client the brief's snippet used.
 *
 * Run: npx vitest run --project integration src/features/process-refund/model/process-refund-rpc.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { FIXTURE_ACCOUNTS, fixturePin, haveFixturePins, type FixtureRole } from '../../../test/fixture-accounts';

interface SeededSale {
  paymentId: string;
  tabId: string;
  productId: string;
  orderItemId: string;
  amount: number;
  stockAfterSale: number;
}

const STAFF_ID = FIXTURE_ACCOUNTS.manager.id;
const UNIT_PRICE = 10;
const INITIAL_STOCK = 100;

/** Ids this file created, so afterAll removes exactly them (never by name prefix). */
const created = { products: [] as string[], categories: [] as string[], cajas: [] as string[], shifts: [] as string[] };

/**
 * Unwinds the sales these fixtures made, in FK order (payments -> tabs and
 * refunds <-> payments are RESTRICT, order_items -> products is RESTRICT),
 * then the products and categories. inventory / stock_movements cascade from
 * products. A failure is thrown so a leak cannot pass silently.
 */
async function removeCreatedFixtures(): Promise<void> {
  const failures: string[] = [];
  const must = (what: string, error: { message: string } | null) => {
    if (error) failures.push(`${what}: ${error.message}`);
  };
  if (created.products.length > 0) {
    const { data: items } = await testDb.from('order_items').select('order_id').in('product_id', created.products);
    const orderIds = [...new Set((items ?? []).map(i => i.order_id))];
    const { data: orders } = await testDb.from('orders').select('tab_id').in('id', orderIds);
    const tabIds = [...new Set((orders ?? []).map(o => o.tab_id))];
    if (tabIds.length > 0) {
      const { data: pays } = await testDb.from('payments').select('id, refund_id').in('tab_id', tabIds);
      const payIds = (pays ?? []).map(p => p.id);
      const refundPayIds = (pays ?? []).filter(p => p.refund_id).map(p => p.id);
      if (refundPayIds.length > 0) must('refund payments', (await testDb.from('payments').delete().in('id', refundPayIds)).error);
      must('refunds', (await testDb.from('refunds').delete().in('original_payment_id', payIds)).error);
      must('payments', (await testDb.from('payments').delete().in('tab_id', tabIds)).error);
      must('tabs', (await testDb.from('tabs').delete().in('id', tabIds)).error);
    }
    must('products', (await testDb.from('products').delete().in('id', created.products)).error);
  }
  if (created.categories.length > 0) must('categories', (await testDb.from('categories').delete().in('id', created.categories)).error);
  if (created.cajas.length > 0) must('caja_sessions', (await testDb.from('caja_sessions').delete().in('id', created.cajas)).error);
  if (created.shifts.length > 0) must('shifts', (await testDb.from('shifts').delete().in('id', created.shifts)).error);
  if (failures.length > 0) throw new Error(`fixture cleanup left rows behind: ${failures.join('; ')}`);
}

afterAll(removeCreatedFixtures);

/**
 * Seeds an isolated category + product + inventory row, an open shift and
 * open caja session for the manager fixture (each on a freshly-minted,
 * never-before-used terminal id so this never collides with another
 * integration test file's own open caja session), then checks the sale out
 * for real through process_direct_sale_atomic (service-role client — see
 * the deviation note above) so the resulting payment/order_item/inventory
 * rows are exactly what a real checkout produces.
 */
async function seedPaidSale(): Promise<SeededSale> {
  const suffix = `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;

  const { data: category, error: catErr } = await testDb
    .from('categories')
    .insert({ name: `IT-refund Category ${suffix}` })
    .select('id')
    .single();
  if (catErr) throw new Error(`category insert failed: ${catErr.message}`);
  created.categories.push(category.id);

  const { data: product, error: prodErr } = await testDb
    .from('products')
    .insert({ name: `IT-refund Product ${suffix}`, category_id: category.id, base_price: UNIT_PRICE, is_active: true })
    .select('id')
    .single();
  if (prodErr) throw new Error(`product insert failed: ${prodErr.message}`);
  const productId = product.id;
  created.products.push(productId);

  const { error: invErr } = await testDb
    .from('inventory')
    .insert({ product_id: productId, quantity_on_hand: INITIAL_STOCK, cost_price: 1 });
  if (invErr) throw new Error(`inventory insert failed: ${invErr.message}`);

  const { data: shift, error: shiftErr } = await testDb
    .from('shifts')
    .insert({ staff_id: STAFF_ID, opening_cash: 0, clock_in: new Date().toISOString() })
    .select('id')
    .single();
  if (shiftErr) throw new Error(`shift insert failed: ${shiftErr.message}`);
  created.shifts.push(shift.id);

  const terminalId = `IT-REF-${suffix}`.slice(0, 32);
  const { data: caja, error: cajaErr } = await testDb
    .from('caja_sessions')
    .insert({ opened_by: STAFF_ID, opening_cash: 0, terminal_id: terminalId })
    .select('id')
    .single();
  if (cajaErr) throw new Error(`caja insert failed: ${cajaErr.message}`);
  created.cajas.push(caja.id);

  const idempotencyKey = `it_refund_seed_${suffix}`;
  const sale = await testDb.rpc('process_direct_sale_atomic', {
    p_staff_id: STAFF_ID,
    p_shift_id: shift.id,
    p_caja_session_id: caja.id,
    p_items: [{ product_id: productId, quantity: 1, unit_price: UNIT_PRICE }],
    p_idempotency_key: idempotencyKey,
    p_method: 'cash',
    p_amount: UNIT_PRICE,
    p_tendered_amount: UNIT_PRICE,
    p_terminal_id: terminalId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_direct_sale_atomic's real signature (repo-wide cast pattern)
  } as any);
  if (sale.error) throw new Error(`process_direct_sale_atomic error: ${sale.error.message}`);
  const result = sale.data as { ok: boolean; tabId?: string; paymentId?: string; code?: string; message?: string };
  if (!result.ok || !result.tabId || !result.paymentId) {
    throw new Error(`process_direct_sale_atomic did not succeed: ${JSON.stringify(result)}`);
  }

  const { data: orderItem, error: oiErr } = await testDb
    .from('order_items')
    .select('id')
    .eq('product_id', productId)
    .single();
  if (oiErr) throw new Error(`order_item lookup failed: ${oiErr.message}`);

  return {
    paymentId: result.paymentId,
    tabId: result.tabId,
    productId,
    orderItemId: orderItem.id,
    amount: UNIT_PRICE,
    stockAfterSale: INITIAL_STOCK - 1,
  };
}

/**
 * The manager fixture approves its own process_refund action (mirrors
 * ticket() in manager-approvals.integration.test.ts) — the fixture manager's
 * role already carries the process_refund RBAC action, and verify_staff_pin
 * auto-resolves the single matching approver when p_approver_id is omitted.
 */
async function seedManagerApproval(action = 'process_refund'): Promise<string> {
  const { data, error } = await supabase.rpc('verify_staff_pin', {
    p_pin: fixturePin('manager'),
    p_staff_id: null,
    p_required_action: action,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind verify_staff_pin's real signature (repo-wide cast pattern)
  } as any);
  if (error) throw new Error(`verify_staff_pin error: ${error.message}`);
  const parsed = data as { ok: boolean; approval_id?: string };
  if (!parsed.ok || !parsed.approval_id) throw new Error(`verify_staff_pin did not approve: ${JSON.stringify(data)}`);
  return parsed.approval_id;
}

/**
 * Fixture passwords go stale when the pepper changes: reseed the derived Auth
 * password via the admin API (never raw SQL; testDb is loopback-guarded) and
 * sign in with it. Throws, so a bad sign-in cannot degrade into anon errors.
 */
async function signInFixture(role: FixtureRole): Promise<void> {
  const acct = FIXTURE_ACCOUNTS[role];
  const password = await deriveStaffPassword(acct.id, fixturePin(role));
  const seeded = await testDb.auth.admin.updateUserById(acct.id, { password });
  if (seeded.error) throw new Error(`${role} password reseed failed: ${seeded.error.message}`);
  await supabase.auth.signOut();
  const { error } = await supabase.auth.signInWithPassword({ email: acct.email, password });
  if (error) throw new Error(`sign-in as ${role} failed: ${error.message}`);
}

describe.skipIf(!haveFixturePins())('process_refund idempotency', () => {
  beforeAll(async () => {
    await signInFixture('manager');
  });

  it('refunding a weighed line with a per-kg promotion returns the amount charged', async () => {
    const suffix = `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
    const { data: category } = await testDb.from('categories').insert({ name: `IT-refund-kg Category ${suffix}` }).select('id').single();
    const { data: product } = await testDb
      .from('products')
      .insert({ name: `IT-refund-kg Product ${suffix}`, category_id: category!.id, base_price: 40, is_active: true, sold_by_weight: true })
      .select('id')
      .single();
    created.categories.push(category!.id);
    created.products.push(product!.id);
    await testDb.from('inventory').insert({ product_id: product!.id, quantity_on_hand: 100000, cost_price: 0 });
    const { data: promo } = await testDb
      .from('promotions')
      .insert({
        name: `IT-refund-kg promo ${suffix}`, kind: 'discount', discount_type: 'fixed', discount_value: 10,
        starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    await testDb.from('promotion_targets').insert({ promotion_id: promo!.id, product_id: product!.id });
    const { data: shift } = await testDb.from('shifts').insert({ staff_id: STAFF_ID, opening_cash: 0, clock_in: new Date().toISOString() }).select('id').single();
    created.shifts.push(shift!.id);
    const terminalId = `IT-REFKG-${suffix}`.slice(0, 32);
    const { data: caja } = await testDb.from('caja_sessions').insert({ opened_by: STAFF_ID, opening_cash: 0, terminal_id: terminalId }).select('id').single();
    created.cajas.push(caja!.id);
    try {
      // 250 g at 40.00/kg = 10.00 line, 10.00 off per kg = 2.50 off -> 7.50 charged
      const sale = await testDb.rpc('process_direct_sale_atomic', {
        p_staff_id: STAFF_ID, p_shift_id: shift!.id, p_caja_session_id: caja!.id,
        p_items: [{ product_id: product!.id, quantity: 1, unit_price: 10, weight_grams: 250 }],
        p_idempotency_key: `it_refund_kg_${suffix}`, p_method: 'cash', p_amount: 7.5, p_tendered_amount: 7.5, p_terminal_id: terminalId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_direct_sale_atomic's real signature
      } as any);
      const result = sale.data as { ok: boolean; tabId: string; paymentId: string };
      expect(result.ok, JSON.stringify(sale.data)).toBe(true);
      const { data: line } = await testDb.from('order_items').select('id, unit_price, discount_amount').eq('product_id', product!.id).single();
      expect(line!.unit_price).toBe(7.5);
      expect(line!.discount_amount).toBe(2.5);
      const refundId = await supabase.rpc('process_refund', {
        p_original_payment_id: result.paymentId,
        p_items: [{ order_item_id: line!.id, qty: 1, amount: 7.5, restock: false }],
        p_reason: 'other',
        p_approval_id: await seedManagerApproval(),
        p_idempotency_key: `idem_refund_kg_${suffix}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_refund's real signature
      } as any);
      expect(refundId.error).toBeNull();
      const negatives = await testDb.from('payments').select('amount').eq('tab_id', result.tabId).lt('amount', 0);
      expect(negatives.data?.map(p => p.amount)).toEqual([-7.5]);
    } finally {
      await testDb.from('promotion_targets').delete().eq('promotion_id', promo!.id);
      await testDb.from('promotions').delete().eq('id', promo!.id);
    }
  });

  it('a replayed refund with the same key does not create a second refund', async () => {
    const sale = await seedPaidSale();
    const approvalId = await seedManagerApproval();
    const key = `idem_test_refund_${String(Date.now())}`;
    const args = {
      p_original_payment_id: sale.paymentId,
      p_items: [{ order_item_id: sale.orderItemId, qty: 1, amount: sale.amount, restock: true }],
      p_reason: 'other',
      p_approval_id: approvalId,
      p_idempotency_key: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_refund's real signature (repo-wide cast pattern)
    } as any;

    const first = await supabase.rpc('process_refund', args);
    expect(first.error).toBeNull();
    expect(first.data).not.toBeNull();
    const second = await supabase.rpc('process_refund', args);
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data); // same refund id returned

    const refunds = await testDb.from('refunds').select('id').eq('original_payment_id', sale.paymentId);
    expect(refunds.data).toHaveLength(1);

    const negatives = await testDb
      .from('payments')
      .select('id, amount')
      .eq('tab_id', sale.tabId)
      .lt('amount', 0);
    expect(negatives.data).toHaveLength(1);

    const inv = await testDb
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', sale.productId)
      .single();
    expect(inv.data?.quantity_on_hand).toBe(sale.stockAfterSale + 1); // restocked once, not twice
  });

  it('a replay after the approval ticket was consumed still returns the original refund', async () => {
    const sale = await seedPaidSale();
    const key = `idem_test_refund_appr_${String(Date.now())}`;
    const approvalId = await seedManagerApproval(); // single-use ticket, see resolve_manager_approval
    const args = {
      p_original_payment_id: sale.paymentId,
      p_items: [{ order_item_id: sale.orderItemId, qty: 1, amount: sale.amount, restock: true }],
      p_reason: 'other',
      p_approval_id: approvalId,
      p_idempotency_key: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_refund's real signature (repo-wide cast pattern)
    } as any;
    const first = await supabase.rpc('process_refund', args);
    expect(first.error).toBeNull();
    expect(first.data).not.toBeNull();
    // The ticket seedManagerApproval() minted was consumed by the call above
    // (resolve_manager_approval sets consumed_at). This replay must still
    // succeed — it must never re-touch that ticket.
    const replay = await supabase.rpc('process_refund', args);
    expect(replay.error).toBeNull();
    expect(replay.data).toBe(first.data);
  });

  it('two concurrent replays of the same key do not double-refund', async () => {
    // Only one of the two concurrent calls ever reaches
    // resolve_manager_approval(): idempotency_begin's advisory xact lock
    // serializes them on the shared key, so the loser blocks until the
    // winner commits, then reads the winner's stored result and returns
    // early WITHOUT touching the approval ticket at all — so a single
    // ticket suffices for a genuinely concurrent pair here (this is a
    // direct consequence of running the replay check before the
    // approval-ticket resolution, see the migration's deviation note).
    const sale = await seedPaidSale();
    const approvalId = await seedManagerApproval();
    const key = `idem_test_refund_race_${String(Date.now())}`;
    const args = {
      p_original_payment_id: sale.paymentId,
      p_items: [{ order_item_id: sale.orderItemId, qty: 1, amount: sale.amount, restock: true }],
      p_reason: 'other',
      p_approval_id: approvalId,
      p_idempotency_key: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase.types.ts lags behind process_refund's real signature (repo-wide cast pattern)
    } as any;

    const [a, b] = await Promise.all([supabase.rpc('process_refund', args), supabase.rpc('process_refund', args)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data).not.toBeNull();
    expect(a.data).toBe(b.data);

    const refunds = await testDb.from('refunds').select('id').eq('original_payment_id', sale.paymentId);
    expect(refunds.data).toHaveLength(1);

    const negatives = await testDb
      .from('payments')
      .select('id, amount')
      .eq('tab_id', sale.tabId)
      .lt('amount', 0);
    expect(negatives.data).toHaveLength(1);
  });
});

/**
 * Offline-first Plan 03: pre-authorised offline approval grants
 * (docs/superpowers/specs/2026-09-29-offline-approval-scope.md). A manager
 * issues grants online against a normal ticket; a grant id then stands in
 * for a ticket in resolve_manager_approval, which every gated RPC calls.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the grant RPCs are not in supabase.types.ts (repo-wide cast pattern) */
const db = supabase as any;

interface IssuedGrant {
  id: string;
  action: string;
  terminal_id: string;
  granted_by: string;
  expires_at: string;
}

// Grants are bound to the session that asked for them (the till's cashier,
// approved by a manager PIN), so they are issued from the cashier session.
async function issueGrants(count = 1, action = 'reopen_tab', validMinutes = 60): Promise<IssuedGrant[]> {
  await signInAs('cashier');
  try {
    return await issueGrantsAsCurrentUser(count, action, validMinutes);
  } finally {
    await signInAs('manager');
  }
}

async function issueGrantsAsCurrentUser(count: number, action: string, validMinutes: number): Promise<IssuedGrant[]> {
  const approvalId = await seedManagerApproval(action);
  const terminalId = `IT-GRANT-${String(Date.now())}`.slice(0, 32);
  const { data, error } = await db.rpc('issue_offline_approval_grants', {
    p_approval_id: approvalId,
    p_approver_id: STAFF_ID,
    p_action: action,
    p_count: count,
    p_valid_minutes: validMinutes,
    p_terminal_id: terminalId,
  });
  if (error) throw new Error(`issue_offline_approval_grants error: ${(error as { message: string }).message}`);
  return data as IssuedGrant[];
}

function refundArgs(sale: SeededSale, approvalId: string, key: string): any {
  return {
    p_original_payment_id: sale.paymentId,
    p_items: [{ order_item_id: sale.orderItemId, qty: 1, amount: sale.amount, restock: true }],
    p_reason: 'other',
    p_approval_id: approvalId,
    p_idempotency_key: key,
  };
}

async function signInAs(role: 'cashier' | 'manager'): Promise<void> {
  await signInFixture(role);
}

describe.skipIf(!haveFixturePins())('offline approval grants', () => {
  beforeAll(async () => {
    await signInAs('manager');
  });

  async function insertGrant(over: Record<string, unknown>): Promise<string> {
    const row = await testDb
      .from('offline_approval_grants' as any)
      .insert({
        action: 'reopen_tab',
        terminal_id: 'POS-1',
        granted_by: STAFF_ID,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        ...over,
      })
      .select('id')
      .single();
    return (row.data as unknown as { id: string }).id;
  }

  it('issues reopen_tab grants bound to the requesting cashier, and audits requested_for without grant ids', async () => {
    const grants = await issueGrants(3);
    expect(grants).toHaveLength(3);
    expect(new Set(grants.map(g => g.id)).size).toBe(3);
    for (const g of grants) {
      expect(g).toMatchObject({ action: 'reopen_tab', granted_by: STAFF_ID, requested_for: FIXTURE_ACCOUNTS.cashier.id });
      expect(Date.parse(g.expires_at)).toBeGreaterThan(Date.now());
    }
    const audit = await testDb
      .from('audit_logs')
      .select('action, terminal_id, after')
      .eq('action', 'approval.offline_grants_issued')
      .eq('terminal_id', grants[0]?.terminal_id ?? '');
    expect(audit.data).toHaveLength(1);
    expect(audit.data?.[0]?.after).toMatchObject({ count: 3, granted_by: STAFF_ID, requested_for: FIXTURE_ACCOUNTS.cashier.id });
    for (const g of grants) {
      expect(JSON.stringify(audit.data)).not.toContain(g.id);
    }
  });

  it('refuses to issue from a grant, any action but reopen_tab, a TTL over 240 minutes or a bad count', async () => {
    const [g] = await issueGrants(1);
    const fromGrant = await db.rpc('issue_offline_approval_grants', {
      p_approval_id: g?.id,
      p_approver_id: null,
      p_action: 'reopen_tab',
      p_count: 1,
      p_valid_minutes: 60,
      p_terminal_id: 'POS-1',
    });
    expect(fromGrant.error?.message ?? '').toContain('APPROVAL_REQUIRED');

    for (const action of ['process_refund', 'edit_paid_tab', 'apply_custom_discount']) {
      await expect(issueGrants(1, action)).rejects.toThrow('VALIDATION_ERROR');
    }
    await expect(issueGrants(1, 'reopen_tab', 241)).rejects.toThrow('VALIDATION_ERROR');
    await expect(issueGrants(1, 'reopen_tab', 720)).rejects.toThrow('VALIDATION_ERROR');
    await expect(issueGrants(11)).rejects.toThrow('VALIDATION_ERROR');
    const [ok240] = await issueGrants(1, 'reopen_tab', 240);
    expect(ok240?.id).toBeTruthy();
  });

  it('never honours a grant as an approval: fresh, bound, legacy, any action, any user', async () => {
    const sale = await seedPaidSale();
    const [fresh] = await issueGrants(1);
    const ids = [
      fresh?.id ?? '',
      await insertGrant({ action: 'process_refund', requested_for: FIXTURE_ACCOUNTS.cashier.id }),
      await insertGrant({ action: 'process_refund' }),
    ];
    for (const user of ['cashier', 'manager'] as const) {
      await signInAs(user);
      try {
        for (const id of ids) {
          const r = await supabase.rpc('process_refund', refundArgs(sale, id, `idem_grant_${user}_${id.slice(0, 8)}_${String(Date.now())}`));
          expect(r.data).toBeNull();
        }
      } finally {
        await signInAs('manager');
      }
    }
    const refunds = await testDb.from('refunds').select('id').eq('original_payment_id', sale.paymentId);
    expect(refunds.data).toHaveLength(0);
    const rows = await testDb.from('offline_approval_grants' as any).select('consumed_at').in('id', ids);
    expect((rows.data as unknown as { consumed_at: string | null }[]).every(r => r.consumed_at === null)).toBe(true);
  });

  it('still lets a cashier refund with a manager ticket, once, attributed to the manager', async () => {
    const sale = await seedPaidSale();
    const second = await seedPaidSale();
    await signInAs('cashier');
    try {
      const ticket = await seedManagerApproval('process_refund');
      const res = await supabase.rpc('process_refund', refundArgs(sale, ticket, `idem_ticket_${String(Date.now())}`));
      expect(res.error).toBeNull();
      expect(res.data).not.toBeNull();
      const again = await supabase.rpc('process_refund', refundArgs(second, ticket, `idem_ticket_b_${String(Date.now())}`));
      expect(again.data).toBeNull();
    } finally {
      await signInAs('manager');
    }
  });

  it('reports a use only for the cashier it was issued to, naming themself, and retires the grant', async () => {
    const [g] = await issueGrants(1);
    const cashierId = FIXTURE_ACCOUNTS.cashier.id;
    const use = { grantId: g?.id, usedBy: cashierId, usedAt: Date.now() - 60_000 };

    // The manager session is not the grant's requester.
    const byOther = await db.rpc('report_offline_approvals', { p_uses: [{ ...use, usedBy: STAFF_ID }] });
    expect(byOther.error?.message ?? '').toContain('AUTH_FORBIDDEN');

    await signInAs('cashier');
    try {
      const spoof = await db.rpc('report_offline_approvals', { p_uses: [{ ...use, usedBy: STAFF_ID }] });
      expect(spoof.error?.message ?? '').toContain('AUTH_FORBIDDEN');
      const first = await db.rpc('report_offline_approvals', { p_uses: [use] });
      expect(first.error).toBeNull();
      expect(first.data).toBe(1);
      const again = await db.rpc('report_offline_approvals', { p_uses: [use] });
      expect(again.data).toBe(0);
    } finally {
      await signInAs('manager');
    }

    const audit = await testDb
      .from('audit_logs')
      .select('after, terminal_id')
      .eq('action', 'approval.offline_used')
      .eq('entity_id', g?.id ?? '');
    expect(audit.data).toHaveLength(1);
    expect(audit.data?.[0]?.after).toMatchObject({ requested_for: cashierId, used_by: cashierId });
    const row = await testDb.from('offline_approval_grants' as any).select('consumed_at, consumed_by').eq('id', g?.id ?? '').single();
    expect(row.data).toMatchObject({ consumed_by: cashierId });
    expect((row.data as unknown as { consumed_at: string | null }).consumed_at).not.toBeNull();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

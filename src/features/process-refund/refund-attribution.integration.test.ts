/**
 * Integration tests: process_refund's p_caja_session_id argument.
 *
 * A refund is attributed to the caja session that pays it out (named by the
 * client), not to the sale's own session, which may already be closed. The
 * RPC refuses before any write when the named session isn't open; when the
 * argument is omitted (an older client), the refund still succeeds and the
 * row's caja_session_id stays NULL — today's fallback behavior.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: npx vitest run src/features/process-refund/refund-attribution.integration.test.ts
 *
 * process_refund uses auth.uid() in SECURITY DEFINER context, so calls must be
 * made with an authenticated user JWT (manager or admin role). The service
 * role client is used only for data seeding (not subject to RLS).
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

function idKey(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2, 9)}`;
}

describe.skipIf(skip)("process_refund's p_caja_session_id (integration)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;

  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let managerShiftId: string;
  let productId: string;
  let cajaAId: string;
  let cajaBId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let managerClient: any;
  let tabId: string;
  let paymentId: string;
  let itemIds: string[] = [];
  const managerPin = String(100000 + Math.floor(Math.random() * 900000));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function signInClient(email: string, password: string): Promise<any> {
    const client = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`signInClient: ${error.message}`);
    return client;
  }

  /** A fresh single-use ticket for process_refund, issued to the manager's session. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function approval(client: any): Promise<string> {
    const { data, error } = await client.rpc('verify_staff_pin', {
      p_pin: managerPin,
      p_staff_id: null,
      p_required_action: 'process_refund',
    });
    if (error || !data?.ok || typeof data.approval_id !== 'string') {
      throw new Error(`approval: ${error?.message ?? JSON.stringify(data)}`);
    }
    return data.approval_id as string;
  }

  beforeAll(async () => {
    const email = `__refund_attribution_mgr_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestRefundAttribution123!';
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`create manager: ${createErr?.message}`);
    managerId = authUser.user.id as string;
    managerEmail = email;
    managerPassword = password;

    const { error: profileErr } = await db.from('profiles').upsert({
      id: managerId,
      name: '__refund_attribution_mgr__',
      email,
      role: 'manager',
      pin: managerPin,
      is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);

    const { data: shift, error: shiftErr } = await db
      .from('shifts')
      .insert({ staff_id: managerId, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !shift) throw new Error(`shift seed failed: ${shiftErr?.message ?? 'no row'}`);
    managerShiftId = shift.id as string;

    const { data: product } = await db.from('products').select('id').eq('is_active', true).limit(1).single();
    if (!product) throw new Error('no active product found for seeding');
    productId = product.id as string;

    // Session A: will be closed after a $100 cash sale, before any refund.
    const terminalA = `RA${String(Date.now())}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
    const { data: cajaA, error: cajaAErr } = await db
      .from('caja_sessions')
      .insert({ opened_by: managerId, opening_cash: 0, terminal_id: terminalA })
      .select('id')
      .single();
    if (cajaAErr || !cajaA) throw new Error(`caja A seed failed: ${cajaAErr?.message ?? 'no row'}`);
    cajaAId = cajaA.id as string;

    // Session B: stays open through the whole test — the paying session.
    const terminalB = `RB${String(Date.now())}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
    const { data: cajaB, error: cajaBErr } = await db
      .from('caja_sessions')
      .insert({ opened_by: managerId, opening_cash: 0, terminal_id: terminalB })
      .select('id')
      .single();
    if (cajaBErr || !cajaB) throw new Error(`caja B seed failed: ${cajaBErr?.message ?? 'no row'}`);
    cajaBId = cajaB.id as string;

    // A $100 cash sale on session A: one order with 10 $10 line items, so a
    // refund can be built from an exact number of whole items.
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `Refund Attribution Tab ${idKey('tab')}`,
        staff_id: managerId,
        shift_id: managerShiftId,
        caja_session_id: cajaAId,
        status: 'paid',
        closed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (tabErr || !tab) throw new Error(`tab insert failed: ${tabErr?.message ?? 'no row'}`);
    tabId = tab.id as string;

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tabId, staff_id: managerId, status: 'served' })
      .select('id')
      .single();
    if (orderErr || !order) throw new Error(`order insert failed: ${orderErr?.message ?? 'no row'}`);

    const { data: items, error: itemErr } = await db
      .from('order_items')
      .insert(
        Array.from({ length: 10 }, () => ({
          order_id: order.id,
          product_id: productId,
          quantity: 1,
          unit_price: 10.0,
          modifier_price_delta: 0,
        }))
      )
      .select('id');
    if (itemErr || !items) throw new Error(`items insert failed: ${itemErr?.message ?? 'no row'}`);
    itemIds = (items as { id: string }[]).map(i => i.id);

    const { data: payment, error: payErr } = await db
      .from('payments')
      .insert({
        tab_id: tabId,
        amount: 100.0,
        method: 'cash',
        processed_by: managerId,
        idempotency_key: idKey('__refund_attribution_seed_payment'),
      })
      .select('id')
      .single();
    if (payErr || !payment) throw new Error(`payment insert failed: ${payErr?.message ?? 'no row'}`);
    paymentId = payment.id as string;

    // Close session A now, before any refund — its reconciliation freezes at 100.
    managerClient = await signInClient(managerEmail, managerPassword);
    const { data: closeData, error: closeErr } = await managerClient.rpc('close_caja_session', {
      p_caja_id: cajaAId,
      p_closed_by: managerId,
      p_closing_cash: 100,
    });
    if (closeErr || !closeData?.ok) {
      throw new Error(`close session A failed: ${closeErr?.message ?? JSON.stringify(closeData)}`);
    }
  });

  afterAll(async () => {
    await managerClient?.auth.signOut().catch(() => undefined);
    if (tabId) {
      const { data: refunds } = await db.from('refunds').select('id').eq('original_payment_id', paymentId);
      for (const r of (refunds ?? []) as { id: string }[]) {
        await db.from('refund_items').delete().eq('refund_id', r.id);
        await db.from('payments').delete().eq('refund_id', r.id);
      }
      await db.from('refunds').delete().eq('original_payment_id', paymentId);
      await db.from('payments').delete().eq('tab_id', tabId);
      await db.from('tabs').delete().eq('id', tabId);
    }
    if (cajaAId) await db.from('caja_sessions').delete().eq('id', cajaAId);
    if (cajaBId) await db.from('caja_sessions').delete().eq('id', cajaBId);
    await db.from('audit_logs').delete().eq('actor_id', managerId);
    await db.from('audit_log').delete().eq('actor_id', managerId);
    for (const [table, column] of [
      ['manager_approvals', 'caller_id'],
      ['stock_movements', 'staff_id'],
      ['shifts', 'staff_id'],
    ] as const) {
      await db.from(table).delete().eq(column, managerId);
    }
    await db.from('pin_attempts').delete().like('attempt_key', `%${managerId}%`);
    await db.from('profiles').delete().eq('id', managerId);
    await db.auth.admin.deleteUser(managerId);
  });

  it('attributes a refund to the named open session, refuses a closed session, and falls back to NULL when omitted', async () => {
    // 1. Refund $40 attributed to open session B.
    const { data: refundId1, error: refundErr1 } = await managerClient.rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: itemIds.slice(0, 4).map(id => ({ order_item_id: id, qty: 1, amount: 10, restock: false })),
      p_reason: 'wrong_order',
      p_approval_id: await approval(managerClient),
      p_approver_id: managerId,
      p_caja_session_id: cajaBId,
    });
    expect(refundErr1).toBeNull();
    expect(typeof refundId1).toBe('string');

    const { data: refundPayment1 } = await db
      .from('payments')
      .select('caja_session_id, amount')
      .eq('refund_id', refundId1)
      .single();
    expect(refundPayment1?.caja_session_id).toBe(cajaBId);
    expect(Number(refundPayment1?.amount)).toBe(-40);

    const { data: reportA1, error: reportA1Err } = await db.rpc('get_caja_report', { p_caja_id: cajaAId });
    expect(reportA1Err).toBeNull();
    expect(reportA1.cashReconciliation.cashSales).toBe(100);

    const { data: reportB1, error: reportB1Err } = await db.rpc('get_caja_report', { p_caja_id: cajaBId });
    expect(reportB1Err).toBeNull();
    expect(reportB1.cashReconciliation.cashSales).toBe(-40);

    // 2. A closed session named on the refund is refused, before any write.
    const { data: paymentsBefore } = await db.from('payments').select('id').eq('tab_id', tabId);
    const countBefore = (paymentsBefore ?? []).length;

    const { data: refundData2, error: refundErr2 } = await managerClient.rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: [{ order_item_id: itemIds[4], qty: 1, amount: 10, restock: false }],
      p_reason: 'wrong_order',
      p_approval_id: await approval(managerClient),
      p_approver_id: managerId,
      p_caja_session_id: cajaAId,
    });
    expect(refundData2).toBeNull();
    expect(refundErr2).not.toBeNull();
    expect(String(refundErr2?.message)).toContain('CAJA_SESSION_NOT_OPEN');

    const { data: paymentsAfter } = await db.from('payments').select('id').eq('tab_id', tabId);
    expect((paymentsAfter ?? []).length).toBe(countBefore);

    // 3. Omitting the argument still succeeds; attribution falls back to NULL
    // (today's behavior — the tax snapshot columns are covered separately).
    const { data: refundId3, error: refundErr3 } = await managerClient.rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: [{ order_item_id: itemIds[4], qty: 1, amount: 10, restock: false }],
      p_reason: 'wrong_order',
      p_approval_id: await approval(managerClient),
      p_approver_id: managerId,
    });
    expect(refundErr3).toBeNull();
    expect(typeof refundId3).toBe('string');

    const { data: refundPayment3 } = await db
      .from('payments')
      .select('caja_session_id, tax_rate_percent')
      .eq('refund_id', refundId3)
      .single();
    expect(refundPayment3?.caja_session_id).toBeNull();
    // Review Focus 2: an old client that omits p_caja_session_id still gets
    // its tax snapshot written.
    expect(refundPayment3?.tax_rate_percent).not.toBeNull();

    // The row's caja_session_id is NULL, but caja_session_payments() falls
    // back to the tab's own session (A) for a NULL-attributed payment — so
    // this $10 refund lands in A's live report even though A is closed and
    // its drawer reconciliation was already frozen at close. Only this
    // refund falls back to A; the $40 refund from step 1 was attributed
    // explicitly to B. Live: 100 (the original sale) - 10 (this refund) = 90.
    // Frozen: still 100, unchanged since close.
    const { data: reportA2, error: reportA2Err } = await db.rpc('get_caja_report', { p_caja_id: cajaAId });
    expect(reportA2Err).toBeNull();
    expect(reportA2.summary.cashSales).toBe(90);
    expect(reportA2.cashReconciliation.cashSales).toBe(100);
  });
});

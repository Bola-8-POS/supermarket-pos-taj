// vi.unmock MUST be the very first statement — overrides the global Supabase
// mock in test-setup.ts, matching receipt-reconstruction.integration.test.ts:
// fetchReceiptDataForPayment reads through the app's shared `supabase`
// singleton (RLS-checked), not a service-role client.
vi.unmock('@shared/lib/supabase');

/**
 * Integration tests: the tax snapshot columns on payments
 * (tax_amount, tax_rate_percent, tax_inclusive), written by
 * process_payment_atomic, process_split_payment_atomic and process_refund,
 * and read back by a reprint instead of today's settings.
 *
 * process_payment_atomic / process_split_payment_atomic are GRANTed to
 * service_role only (mirrors split-payment-rpc.integration.test.ts).
 * process_refund uses auth.uid(), so it is called with a manager JWT.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: npx vitest run src/entities/payment/model/payment-tax-snapshot.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { supabase } from '@shared/lib/supabase';
import { fetchReceiptDataForPayment } from './queries';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

function idKey(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2, 9)}`;
}

describe.skipIf(skip)('payment tax snapshot (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;

  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let managerShiftId: string;
  let productId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let managerClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalBilling: any;
  let hadBillingRow = false;
  const managerPin = String(100000 + Math.floor(Math.random() * 900000));
  const tabIds: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function signInClient(email: string, password: string): Promise<any> {
    const client = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`signInClient: ${error.message}`);
    return client;
  }

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

  async function setBilling(value: { taxRatePercent: number; taxInclusive: boolean }): Promise<void> {
    // No 'billing' row exists in a fresh local stack — upsert (not update),
    // or a missing row makes this a silent no-op.
    const { error } = await db.from('settings').upsert({ key: 'billing', value }, { onConflict: 'key' });
    if (error) throw new Error(`setBilling: ${error.message}`);
  }

  /** Seeds a tab with one order + one $116 order_item, so a reprint has real rows to read. */
  async function seedTab(): Promise<{ tabId: string; itemId: string }> {
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `Payment Tax Snapshot ${idKey('tab')}`,
        staff_id: managerId,
        shift_id: managerShiftId,
        status: 'open',
      })
      .select('id')
      .single();
    if (tabErr || !tab) throw new Error(`seedTab: ${tabErr?.message ?? 'no row'}`);
    tabIds.push(tab.id as string);

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tab.id, staff_id: managerId, status: 'served' })
      .select('id')
      .single();
    if (orderErr || !order) throw new Error(`seedTab order: ${orderErr?.message ?? 'no row'}`);

    const { data: item, error: itemErr } = await db
      .from('order_items')
      .insert({ order_id: order.id, product_id: productId, quantity: 1, unit_price: 116.0, modifier_price_delta: 0 })
      .select('id')
      .single();
    if (itemErr || !item) throw new Error(`seedTab item: ${itemErr?.message ?? 'no row'}`);

    return { tabId: tab.id as string, itemId: item.id as string };
  }

  beforeAll(async () => {
    const email = `__payment_tax_snapshot_mgr_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestPaymentTaxSnapshot123!';
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
      name: '__payment_tax_snapshot_mgr__',
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

    const { data: billingRow } = await db.from('settings').select('value').eq('key', 'billing').maybeSingle();
    hadBillingRow = billingRow != null;
    originalBilling = billingRow?.value ?? { taxRatePercent: 16, taxInclusive: true };

    await setBilling({ taxRatePercent: 16, taxInclusive: true });
    managerClient = await signInClient(managerEmail, managerPassword);
    // fetchReceiptDataForPayment reads through the shared `supabase` singleton
    // (RLS-checked), not a service-role client, so that singleton also signs in.
    await supabase.auth.signInWithPassword({ email: managerEmail, password: managerPassword });
  });

  afterAll(async () => {
    await supabase.auth.signOut().catch(() => undefined);
    await managerClient?.auth.signOut().catch(() => undefined);
    try {
      if (hadBillingRow) {
        await setBilling(originalBilling);
      } else {
        await db.from('settings').delete().eq('key', 'billing');
      }
    } catch {
      // best-effort cleanup — ignore
    }
    for (const tabId of tabIds) {
      const { data: payments } = await db.from('payments').select('id').eq('tab_id', tabId).eq('is_refund', false);
      for (const p of (payments ?? []) as { id: string }[]) {
        const { data: refunds } = await db.from('refunds').select('id').eq('original_payment_id', p.id);
        for (const r of (refunds ?? []) as { id: string }[]) {
          await db.from('refund_items').delete().eq('refund_id', r.id);
          await db.from('payments').delete().eq('refund_id', r.id);
        }
        await db.from('refunds').delete().eq('original_payment_id', p.id);
      }
      await db.from('payments').delete().eq('tab_id', tabId);
      await db.from('tabs').delete().eq('id', tabId);
    }
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

  it('snapshots the tax rate/amount at sale time, a reprint reads the snapshot, and a refund copies the original', async () => {
    const single = await seedTab();
    const singleTabId = single.tabId;
    const split = await seedTab();
    const splitTabId = split.tabId;

    // 1. A single $116 cash payment at 16% inclusive.
    const { data: payRes, error: payErr } = await db.rpc('process_payment_atomic', {
      p_tab_id: singleTabId,
      p_staff_id: managerId,
      p_amount: 116.0,
      p_method: 'cash',
      p_idempotency_key: idKey('__payment_tax_snapshot_single'),
      p_tendered_amount: 116.0,
    });
    expect(payErr).toBeNull();
    expect(payRes.ok).toBe(true);

    const { data: singleRow } = await db
      .from('payments')
      .select('id, tax_amount, tax_rate_percent, tax_inclusive')
      .eq('id', payRes.paymentId)
      .single();
    expect(Number(singleRow?.tax_amount)).toBe(16.0);
    expect(Number(singleRow?.tax_rate_percent)).toBe(16);
    expect(singleRow?.tax_inclusive).toBe(true);

    // 2. A 60 + 56 split on a second tab.
    const { data: splitRes, error: splitErr } = await db.rpc('process_split_payment_atomic', {
      p_tab_id: splitTabId,
      p_staff_id: managerId,
      p_legs: [
        { method: 'cash', amount: 60.0, tenderedAmount: 60.0 },
        { method: 'cash', amount: 56.0, tenderedAmount: 56.0 },
      ],
      p_expected_total: 116.0,
      p_idempotency_key: idKey('__payment_tax_snapshot_split'),
    });
    expect(splitErr).toBeNull();
    expect(splitRes.ok).toBe(true);

    const { data: splitRows } = await db
      .from('payments')
      .select('split_index, tax_amount, tax_rate_percent, tax_inclusive')
      .eq('payment_group_id', splitRes.paymentGroupId)
      .order('split_index');
    const legs = (splitRows ?? []) as { split_index: number; tax_amount: number; tax_rate_percent: number; tax_inclusive: boolean }[];
    expect(legs).toHaveLength(2);
    expect(Number(legs[0]?.tax_amount)).toBe(8.28);
    expect(Number(legs[1]?.tax_amount)).toBe(7.72);
    expect(Number(legs[0]?.tax_rate_percent)).toBe(16);
    expect(legs[0]?.tax_inclusive).toBe(true);

    // 3. The billing rate changes; a reprint of either tab still shows the
    // rate that applied at sale time, not today's.
    await setBilling({ taxRatePercent: 8, taxInclusive: true });

    const singleReceipt = await fetchReceiptDataForPayment(singleTabId);
    expect(singleReceipt.taxRatePercent).toBe(16);
    expect(singleReceipt.taxAmount).toBe(16.0);

    const splitReceipt = await fetchReceiptDataForPayment(splitTabId);
    expect(splitReceipt.taxRatePercent).toBe(16);
    expect(splitReceipt.taxAmount).toBe(16.0);

    // 4. A $58 refund on the $116 payment copies the original row's rate,
    // not the (now 8%) setting.
    const { data: refundId, error: refundErr } = await managerClient.rpc('process_refund', {
      p_original_payment_id: payRes.paymentId,
      p_items: [{ order_item_id: single.itemId, qty: 1, amount: 58, restock: false }],
      p_reason: 'wrong_order',
      p_approval_id: await approval(managerClient),
      p_approver_id: managerId,
    });
    expect(refundErr).toBeNull();
    expect(typeof refundId).toBe('string');

    const { data: refundRow } = await db
      .from('payments')
      .select('tax_amount, tax_rate_percent, tax_inclusive')
      .eq('refund_id', refundId)
      .single();
    expect(Number(refundRow?.tax_amount)).toBe(-8.0);
    expect(Number(refundRow?.tax_rate_percent)).toBe(16);
    expect(refundRow?.tax_inclusive).toBe(true);
  });
});

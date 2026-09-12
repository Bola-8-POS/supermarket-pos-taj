import { expect, test, type Page } from '../fixtures';
import { loginAs } from '../helpers/auth';
import {
  deleteTestStaff,
  getInventoryQty,
  getServiceClient,
  openCaja,
  resetTestState,
  seedNewStaffMember,
} from '../helpers/supabase';
import { getBillingTaxConfig, computeAuthoritativeTotal } from '../helpers/tax';
import { requireIntegrationEnv } from '../helpers/requireEnv';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

let cajaSessionId = '';

/**
 * Reads the current browser session's Supabase access token out of
 * localStorage (supabase-js persists it under a key containing
 * "auth-token" — found dynamically rather than hardcoding the project-ref
 * prefix, which differs between the self-hosted local stack and CI).
 * Lets a test call an Edge Function directly with the exact JWT the app
 * itself is using, without re-deriving supabase-js's storage key format.
 */
async function getAccessToken(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.includes('auth-token'));
    return key ? localStorage.getItem(key) : null;
  });
  if (!raw) throw new Error('getAccessToken: no Supabase auth session found in localStorage');
  const parsed = JSON.parse(raw) as { access_token?: string };
  if (!parsed.access_token) throw new Error('getAccessToken: stored session has no access_token');
  return parsed.access_token;
}

/** POSTs directly to the deployed process-direct-sale Edge Function (CHK-03/CHK-04 boundary tests). */
async function callProcessDirectSaleEdge(
  accessToken: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error('Missing VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY');
  const res = await fetch(`${supabaseUrl}/functions/v1/process-direct-sale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Converts directSaleInput()'s snake_case RPC args into the Edge Function's camelCase body. */
function toEdgeBody(
  args: {
    p_shift_id: string;
    p_caja_session_id: string;
    p_items: { product_id: string; quantity: number; unit_price: number }[];
    p_method: string;
    p_amount: number;
    p_tendered_amount: number;
  },
  idempotencyKey: string
): Record<string, unknown> {
  return {
    items: args.p_items.map(item => ({
      productId: item.product_id,
      quantity: item.quantity,
      unitPrice: item.unit_price,
    })),
    shiftId: args.p_shift_id,
    cajaSessionId: args.p_caja_session_id,
    idempotencyKey,
    method: args.p_method,
    amount: args.p_amount,
    tenderedAmount: args.p_tendered_amount,
  };
}

test.describe('Direct-sale checkout', () => {
  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    cajaSessionId = await openCaja(500);
    await page.goto('/');
    await loginAs(page, 'cashier');
  });

  test('offline blocking dialog also appears when submitting a split payment', async ({ page }) => {
    const admin = getServiceClient();
    const { data: product, error } = await admin
      .from('products')
      .select('base_price')
      .eq('name', "Haldiram's Aloo Bhujia 200g")
      .single();
    if (error || !product) throw new Error(error?.message ?? 'Product not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    const total = computeAuthoritativeTotal(Number(product.base_price), taxRatePercent, taxInclusive);
    const cashAmount = Math.round((total / 2) * 100) / 100;
    const cardAmount = Math.round((total - cashAmount) * 100) / 100;

    await page.getByRole('button', { name: /checkout/i }).click();
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/split payment/i).click();

    const cardButtons = page.getByTestId('split-payment-btn-card');
    await cardButtons.last().click();
    const amountInputs = page.getByLabel(/amount$/i);
    await amountInputs.nth(0).fill(cashAmount.toFixed(2));
    await amountInputs.nth(1).fill(cardAmount.toFixed(2));
    await page.getByLabel(/amount tendered/i).fill(cashAmount.toFixed(2));

    await page.context().setOffline(true);
    await page.getByRole('button', { name: /process split payment/i }).click();

    const dialog = page.getByRole('alertdialog').filter({ hasText: /offline/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await page.context().setOffline(false);
  });

  async function directSaleInput(priceOffset = 0) {
    const admin = getServiceClient();
    const { data: shift, error: shiftError } = await admin
      .from('shifts')
      .select('id, staff_id')
      .is('clock_out', null)
      .limit(1)
      .maybeSingle();
    if (shiftError || !shift) throw new Error(shiftError?.message ?? 'Open shift not found');
    const { data: product, error: productError } = await admin
      .from('products')
      .select('id, base_price')
      .eq('name', "Haldiram's Aloo Bhujia 200g")
      .single();
    if (productError || !product) throw new Error(productError?.message ?? 'Product not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    const total = computeAuthoritativeTotal(Number(product.base_price), taxRatePercent, taxInclusive);
    return {
      admin,
      total,
      args: {
        p_staff_id: shift.staff_id,
        p_shift_id: shift.id,
        p_caja_session_id: cajaSessionId,
        p_items: [
          {
            product_id: product.id,
            quantity: 1,
            unit_price: Number(product.base_price) + priceOffset,
          },
        ],
        p_idempotency_key: `direct-sale-${randomUUID()}`,
        p_method: 'cash',
        p_amount: total,
        p_tendered_amount: 100,
      },
    };
  }

  test('reuses an idempotency key without creating a second payment or stock decrement', async () => {
    const { admin, args } = await directSaleInput();
    const first = await admin.rpc('process_direct_sale_atomic', args);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ ok: true, idempotent: false });
    const second = await admin.rpc('process_direct_sale_atomic', args);
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ ok: true, idempotent: true, tabId: first.data.tabId });
    const { count } = await admin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', args.p_idempotency_key);
    expect(count).toBe(1);
  });

  test('snapshots inventory cost_price server-side and ignores a supplied snapshot', async () => {
    const { admin, args } = await directSaleInput();
    const productId = args.p_items[0].product_id;
    const knownCost = 4.25;
    const inventory = await admin
      .from('inventory')
      .update({ cost_price: knownCost })
      .eq('product_id', productId);
    if (inventory.error) throw new Error(inventory.error.message);

    expect(args.p_items[0]).not.toHaveProperty('cost_price_snapshot');
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_items: [{ ...args.p_items[0], cost_price_snapshot: 99999 }],
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: true });

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('id')
      .eq('tab_id', result.data.tabId)
      .single();
    if (orderError || !order) throw new Error(orderError?.message ?? 'Order not found');
    const { data: item, error: itemError } = await admin
      .from('order_items')
      .select('cost_price_snapshot')
      .eq('order_id', order.id)
      .single();
    if (itemError || !item) throw new Error(itemError?.message ?? 'Order item not found');
    expect(Number(item.cost_price_snapshot)).toBe(knownCost);
  });

  test('reuses a split idempotency key without creating a second sale or stock decrement', async () => {
    const quantityBefore = await getInventoryQty("Haldiram's Aloo Bhujia 200g");
    const { admin, args } = await directSaleInput();
    const amount = Number(args.p_amount);
    const cashAmount = Math.round((amount / 2) * 100) / 100;
    const cardAmount = Math.round((amount - cashAmount) * 100) / 100;
    const splitArgs = {
      ...args,
      p_method: null,
      p_amount: null,
      p_tendered_amount: null,
      p_legs: [
        { method: 'cash', amount: cashAmount, tenderedAmount: cashAmount },
        { method: 'card', amount: cardAmount },
      ],
      p_expected_total: amount,
    };

    const first = await admin.rpc('process_direct_sale_atomic', splitArgs);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ ok: true, idempotent: false });
    const second = await admin.rpc('process_direct_sale_atomic', splitArgs);
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ ok: true, idempotent: true, tabId: first.data.tabId });
    expect(second.data.paymentIds).toEqual(first.data.paymentIds);
    const { count } = await admin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .in('idempotency_key', [`${args.p_idempotency_key}-leg0`, `${args.p_idempotency_key}-leg1`]);
    expect(count).toBe(2);
    await expect
      .poll(() => getInventoryQty("Haldiram's Aloo Bhujia 200g"))
      .toBe(quantityBefore - 1);
  });

  test('rejects a tampered price before creating any rows', async () => {
    const { admin, args } = await directSaleInput(0.02);
    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', args);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'PRICE_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a zero-amount cash payment and writes no rows', async () => {
    const { admin, args } = await directSaleInput();
    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_amount: 0,
      p_tendered_amount: 0,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a partial cash payment and writes no rows', async () => {
    const { admin, args } = await directSaleInput();
    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_amount: 1,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a sale against a caja session that is not open', async () => {
    const { admin, args } = await directSaleInput();
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_caja_session_id: randomUUID(),
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'CAJA_CLOSED' });
  });

  test('rejects a sale against a shift that is not open', async () => {
    const { admin, args } = await directSaleInput();
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_shift_id: randomUUID(),
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'SHIFT_NOT_OPEN' });
  });

  test('rejects a card override below the derived total and writes no rows', async () => {
    const { admin, args, total } = await directSaleInput();
    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_method: 'card',
      p_amount: Math.round((total - 1) * 100) / 100,
      p_tendered_amount: null,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a non-null direct-sale discount payload without manager authorization and writes no rows', async () => {
    // Phase 27 (Plan 01/04, PROMO-05) replaced the old blanket
    // DISCOUNT_UNSUPPORTED hard-block with a manager-authorization gate: an
    // ad-hoc discount is now actually supported, but only with
    // p_manager_override=true and a manager-role staff member (see
    // process-direct-sale-atomic-promotions.sql). This request omits both,
    // so it's rejected as DISCOUNT_REQUIRES_MANAGER — still no rows written.
    const { admin, args } = await directSaleInput();
    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_discount_scope: 'all',
      p_discount_type: 'percent',
      p_discount_value: 10,
      p_discount_amount: 1,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'DISCOUNT_REQUIRES_MANAGER' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a forged zero modifier delta that undercounts the total and writes no rows', async () => {
    const admin = getServiceClient();
    const { data: shift, error: shiftError } = await admin
      .from('shifts')
      .select('id, staff_id')
      .is('clock_out', null)
      .limit(1)
      .maybeSingle();
    if (shiftError || !shift) throw new Error(shiftError?.message ?? 'Open shift not found');
    const { data: product, error: productError } = await admin
      .from('products')
      .select('id, base_price')
      .eq('name', 'MDH Garam Masala 100g')
      .single();
    if (productError || !product)
      throw new Error(productError?.message ?? 'MDH Garam Masala 100g not found');
    const { data: modifier, error: modifierError } = await admin
      .from('modifiers')
      .select('id')
      .eq('name', 'Gift Wrap')
      .single();
    if (modifierError || !modifier)
      throw new Error(modifierError?.message ?? 'Gift Wrap modifier not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    // Totals the sale as if the modifier were free, forging a zero delta on
    // the item itself -- the server must still derive the real, non-zero
    // delta from product_modifiers/modifiers and reject the undercounted total.
    const totalIgnoringModifier = computeAuthoritativeTotal(
      Number(product.base_price),
      taxRatePercent,
      taxInclusive
    );

    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      p_staff_id: shift.staff_id,
      p_shift_id: shift.id,
      p_caja_session_id: cajaSessionId,
      p_items: [
        {
          product_id: product.id,
          quantity: 1,
          unit_price: Number(product.base_price),
          modifier_ids: [modifier.id],
          modifier_price_delta: 0,
        },
      ],
      p_idempotency_key: `direct-sale-${randomUUID()}`,
      p_method: 'cash',
      p_amount: totalIgnoringModifier,
      p_tendered_amount: 100,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a modifier not linked to the item product and writes no rows', async () => {
    const { admin, args } = await directSaleInput();
    const { data: modifier, error: modifierError } = await admin
      .from('modifiers')
      .select('id')
      .eq('name', 'Gift Wrap')
      .single();
    if (modifierError || !modifier)
      throw new Error(modifierError?.message ?? 'Gift Wrap modifier not found');

    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_items: [{ ...args.p_items[0], modifier_ids: [modifier.id] }],
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'MODIFIER_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('rejects a split expected total below the derived total and writes no rows', async () => {
    const { admin, args, total } = await directSaleInput();
    const wrongTotal = Math.round((total - 1) * 100) / 100;
    const cashAmount = Math.round((wrongTotal / 2) * 100) / 100;
    const cardAmount = Math.round((wrongTotal - cashAmount) * 100) / 100;

    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const result = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_method: null,
      p_amount: null,
      p_tendered_amount: null,
      p_legs: [
        { method: 'cash', amount: cashAmount, tenderedAmount: cashAmount },
        { method: 'card', amount: cardAmount },
      ],
      p_expected_total: wrongTotal,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, code: 'AMOUNT_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);
  });

  test('replay from a different cashier is rejected without leaking the original sale', async () => {
    const replayStaffName = 'E2E Direct-Sale Replay Cashier';
    await deleteTestStaff(replayStaffName).catch(() => undefined);

    const { admin, args } = await directSaleInput();
    const first = await admin.rpc('process_direct_sale_atomic', args);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ ok: true, idempotent: false });

    const replayStaffId = await seedNewStaffMember(replayStaffName, '919191', 'cashier');
    const { data: replayShift, error: replayShiftError } = await admin
      .from('shifts')
      .insert({ staff_id: replayStaffId, opening_cash: 0 })
      .select('id')
      .single();
    if (replayShiftError || !replayShift)
      throw new Error(replayShiftError?.message ?? 'Replay shift insert failed');

    const replay = await admin.rpc('process_direct_sale_atomic', {
      ...args,
      p_staff_id: replayStaffId,
      p_shift_id: replayShift.id,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ ok: false, code: 'IDEMPOTENCY_UNAUTHORIZED' });
    expect(replay.data.tabId).toBeUndefined();
    expect(replay.data.paymentId).toBeUndefined();

    await deleteTestStaff(replayStaffName).catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Plan 02-07 (CHK-03/CHK-04 gap closure): edge-function-level receipt
  // authorization and truthful split receipts.
  // -------------------------------------------------------------------------

  test('original-cashier replay through the edge function returns the same sale-level receipt with no new payment', async ({
    page,
  }) => {
    const { admin, args, total } = await directSaleInput();
    const idempotencyKey = `direct-sale-edge-${randomUUID()}`;
    const accessToken = await getAccessToken(page);
    const body = toEdgeBody(args, idempotencyKey);

    const first = await callProcessDirectSaleEdge(accessToken, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ success: true, idempotent: false });
    const firstReceipt = first.json.receiptData as { total: number } | undefined;
    expect(firstReceipt).toBeTruthy();
    expect(firstReceipt?.total).toBeCloseTo(total, 2);

    const second = await callProcessDirectSaleEdge(accessToken, body);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ success: true, idempotent: true, tabId: first.json.tabId });
    const secondReceipt = second.json.receiptData as { total: number } | undefined;
    expect(secondReceipt).toBeTruthy();
    expect(secondReceipt?.total).toBeCloseTo(total, 2);

    const { count } = await admin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', idempotencyKey);
    expect(count).toBe(1);
  });

  test('cross-cashier replay through the edge function is rejected without leaking receipt data', async ({
    page,
  }) => {
    const replayStaffName = 'E2E Direct-Sale Edge Replay Cashier';
    const replayPin = '929292';
    await deleteTestStaff(replayStaffName).catch(() => undefined);

    const { admin, args } = await directSaleInput();
    const idempotencyKey = `direct-sale-edge-${randomUUID()}`;
    const accessToken = await getAccessToken(page);
    const body = toEdgeBody(args, idempotencyKey);

    const first = await callProcessDirectSaleEdge(accessToken, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ success: true });

    const replayStaffId = await seedNewStaffMember(replayStaffName, replayPin, 'cashier');
    const { data: replayShift, error: replayShiftError } = await admin
      .from('shifts')
      .insert({ staff_id: replayStaffId, opening_cash: 0 })
      .select('id')
      .single();
    if (replayShiftError || !replayShift)
      throw new Error(replayShiftError?.message ?? 'Replay shift insert failed');

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey)
      throw new Error('Missing VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY');
    const replayClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: signInError } = await replayClient.auth.signInWithPassword({
      email: `${replayStaffName.toLowerCase().replace(/\s+/g, '-')}@e2e-test.local`,
      password: replayPin,
    });
    if (signInError || !authData.session)
      throw new Error(signInError?.message ?? 'Replay cashier sign-in failed');

    const replayBody = { ...body, shiftId: replayShift.id };
    const replay = await callProcessDirectSaleEdge(authData.session.access_token, replayBody);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.json.success).toBe(false);
    expect(replay.json.tabId).toBeUndefined();
    expect(replay.json.paymentId).toBeUndefined();
    expect(replay.json.receiptData).toBeUndefined();

    await deleteTestStaff(replayStaffName).catch(() => undefined);
  });

  test('split payment returns one truthful sale-level receipt with the basket once and every tender leg', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const { data: product, error } = await admin
      .from('products')
      .select('base_price')
      .eq('name', "Haldiram's Aloo Bhujia 200g")
      .single();
    if (error || !product) throw new Error(error?.message ?? 'Product not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    const total = computeAuthoritativeTotal(Number(product.base_price), taxRatePercent, taxInclusive);
    const cashAmount = Math.round((total / 2) * 100) / 100;
    const cardAmount = Math.round((total - cashAmount) * 100) / 100;

    await page.getByRole('button', { name: /checkout/i }).click();
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/split payment/i).click();

    const cardButtons = page.getByTestId('split-payment-btn-card');
    await cardButtons.last().click();
    const amountInputs = page.getByLabel(/amount$/i);
    await amountInputs.nth(0).fill(cashAmount.toFixed(2));
    await amountInputs.nth(1).fill(cardAmount.toFixed(2));
    await page.getByLabel(/amount tendered/i).fill(cashAmount.toFixed(2));

    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/process-direct-sale') && resp.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /process split payment/i }).click();
    const response = await responsePromise;
    const body = (await response.json()) as {
      success: boolean;
      receipts?: unknown;
      receiptData?: {
        items: { quantity: number }[];
        subtotal: number;
        total: number;
        tenders?: { method: string; amount: number }[];
      };
    };

    expect(body.success).toBe(true);
    expect(body.receipts).toBeUndefined();
    expect(body.receiptData).toBeTruthy();
    // The basket appears exactly once — not once per tender leg (CR-03).
    expect(body.receiptData?.items).toHaveLength(1);
    expect(body.receiptData?.items[0]?.quantity).toBe(1);
    // Every tender leg is present and its amounts sum to what was actually
    // charged (`total`) — under taxInclusive mode `subtotal` is the
    // decomposed pre-tax amount and no longer equals the sum of tenders.
    expect(body.receiptData?.tenders).toHaveLength(2);
    const tenderSum = (body.receiptData?.tenders ?? []).reduce((sum, t) => sum + t.amount, 0);
    expect(Math.round(tenderSum * 100) / 100).toBeCloseTo(body.receiptData?.total ?? 0, 2);
    expect(new Set(body.receiptData?.tenders?.map(t => t.method))).toEqual(
      new Set(['cash', 'card'])
    );

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
  });
});

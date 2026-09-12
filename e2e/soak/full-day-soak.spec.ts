import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '../fixtures';
import { gotoAuthed, loginAs, logout } from '../helpers/auth';
import { getServiceClient, openCaja, resetTestState } from '../helpers/supabase';
import { getBillingTaxConfig, computeAuthoritativeTotal } from '../helpers/tax';
import { requireIntegrationEnv } from '../helpers/requireEnv';
import type { SupabaseClient } from '@supabase/supabase-js';

let cajaSessionId = '';

async function scanBarcode(page: Page, barcode: string): Promise<void> {
  await page.evaluate(code => {
    for (const key of [...code, 'Enter']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
  }, barcode);
}

async function payCash(page: Page, tendered = 100): Promise<void> {
  await page
    .getByRole('button', { name: /^process payment$/i })
    .first()
    .click();
  await page.getByLabel(/amount tendered/i).fill(tendered.toFixed(2));
  await page
    .getByRole('button', { name: /^process payment$/i })
    .last()
    .click();
  await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /done/i }).click();
  await expect(page.getByText(/cart is empty/i)).toBeVisible();
}

async function productPrice(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin
    .from('products')
    .select('base_price')
    .eq('name', name)
    .single();
  if (error || !data) throw new Error(error?.message ?? `Product ${name} not found`);
  return Number(data.base_price);
}

async function cashSalesForCaja(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from('payments')
    .select('amount, tabs!inner(caja_session_id)')
    .eq('method', 'cash')
    .eq('is_deleted', false)
    .neq('status', 'reopened_void')
    .eq('tabs.caja_session_id', cajaSessionId);
  if (error || !data) throw new Error(error?.message ?? 'Cash payment total unavailable');
  return data.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

async function createOpenUnitProduct(admin: SupabaseClient): Promise<string> {
  const { data: category, error: categoryError } = await admin
    .from('categories')
    .select('id')
    .limit(1)
    .single();
  if (categoryError || !category)
    throw new Error(categoryError?.message ?? 'No category available');

  const suffix = randomUUID();
  const packageName = `E2E Soak Box ${suffix}`;
  const looseName = `E2E Soak Loose ${suffix}`;
  const { data: packageProduct, error: packageError } = await admin
    .from('products')
    .insert({
      name: packageName,
      category_id: category.id,
      base_price: 12,
      is_active: true,
      units_per_package: 12,
    } as never)
    .select('id')
    .single();
  if (packageError || !packageProduct)
    throw new Error(packageError?.message ?? 'Unable to create open-unit package');
  const { error: inventoryError } = await admin
    .from('inventory')
    .upsert(
      { product_id: packageProduct.id, quantity_on_hand: 1, low_stock_threshold: 0, unit: 'unit' },
      { onConflict: 'product_id' }
    );
  if (inventoryError) throw new Error(inventoryError.message);
  const { data: looseProduct, error: looseError } = await admin
    .from('products')
    .insert({
      name: looseName,
      category_id: category.id,
      base_price: 2,
      is_active: true,
      parent_product_id: packageProduct.id,
    } as never)
    .select('name')
    .single();
  if (looseError || !looseProduct)
    throw new Error(looseError?.message ?? 'Unable to create loose-piece product');
  return looseProduct.name;
}

test.describe.serial('Full-day soak', () => {
  test('runs a realistic day from opening to reconciled close', async ({ page }) => {
    test.setTimeout(360_000);
    requireIntegrationEnv();
    await resetTestState();
    cajaSessionId = await openCaja(500);
    const admin = getServiceClient();
    // resetTestState() excludes the 4 pinned E2E accounts from its es-MX
    // reset (so their locale doesn't get force-reverted), but it never
    // pushes them back TO en-US either — if something else (another spec,
    // another concurrently-running E2E run against this shared DB) left
    // the cashier/manager account at es-MX, it stays that way. This test's
    // English-only UI selectors need the accounts' documented en-US
    // baseline, so restore it explicitly rather than trusting prior state.
    await admin
      .from('profiles')
      .update({ locale: 'en-US' })
      .in('name', [
        process.env['E2E_BARTENDER_NAME'] ?? '',
        process.env['E2E_MANAGER_NAME'] ?? '',
      ]);
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    let totalCashCollected = 0;

    await page.goto('/');
    await loginAs(page, 'cashier');
    // The shared "cashier" E2E account's locale isn't guaranteed en-US at
    // test-run time — match both locales (wPanels.json's `pos` tile:
    // "Checkout" en-US / "Cobro" es-MX).
    await page.getByRole('button', { name: /checkout|cobro/i }).click();

    const { data: shift, error: shiftError } = await admin
      .from('shifts')
      .select('id, staff_id')
      .is('clock_out', null)
      .limit(1)
      .single();
    if (shiftError || !shift) throw new Error(shiftError?.message ?? 'Open shift not found');
    const { data: saleProduct, error: saleProductError } = await admin
      .from('products')
      .select('id, base_price, barcode')
      .eq('name', 'MDH Garam Masala 100g')
      .single();
    if (saleProductError || !saleProduct)
      throw new Error(saleProductError?.message ?? 'MDH Garam Masala 100g not found');
    const bulkAmount = computeAuthoritativeTotal(
      Number(saleProduct.base_price),
      taxRatePercent,
      taxInclusive
    );

    for (let index = 0; index < 70; index += 1) {
      const result = await admin.rpc('process_direct_sale_atomic', {
        p_staff_id: shift.staff_id,
        p_shift_id: shift.id,
        p_caja_session_id: cajaSessionId,
        p_items: [
          { product_id: saleProduct.id, quantity: 1, unit_price: Number(saleProduct.base_price) },
        ],
        p_idempotency_key: `full-day-${randomUUID()}`,
        p_method: 'cash',
        p_amount: bulkAmount,
        p_tendered_amount: 100,
      });
      expect(result.error, `bulk sale ${index + 1} returned an RPC error`).toBeNull();
      expect(result.data, `bulk sale ${index + 1} did not commit`).toMatchObject({ ok: true });
      totalCashCollected += bulkAmount;
    }

    const [{ count: paymentsBefore }, { count: tabsBefore }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    const tamperedSale = await admin.rpc('process_direct_sale_atomic', {
      p_staff_id: shift.staff_id,
      p_shift_id: shift.id,
      p_caja_session_id: cajaSessionId,
      p_items: [
        {
          product_id: saleProduct.id,
          quantity: 1,
          unit_price: Number(saleProduct.base_price) + 0.02,
        },
      ],
      p_idempotency_key: `tampered-${randomUUID()}`,
      p_method: 'cash',
      p_amount: bulkAmount,
      p_tendered_amount: 100,
    });
    expect(tamperedSale.error).toBeNull();
    expect(tamperedSale.data).toMatchObject({ ok: false, code: 'PRICE_MISMATCH' });
    const [{ count: paymentsAfter }, { count: tabsAfter }] = await Promise.all([
      admin.from('payments').select('id', { count: 'exact', head: true }),
      admin.from('tabs').select('id', { count: 'exact', head: true }),
    ]);
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(tabsAfter).toBe(tabsBefore);

    const { data: manager, error: managerError } = await admin
      .from('profiles')
      .select('id')
      .eq('role', 'manager')
      .limit(1)
      .single();
    const { data: receivingInventory, error: receivingInventoryError } = await admin
      .from('inventory')
      .select('product_id, quantity_on_hand')
      .limit(1)
      .single();
    if (managerError || !manager || receivingInventoryError || !receivingInventory) {
      throw new Error(
        managerError?.message ?? receivingInventoryError?.message ?? 'Receiving fixture missing'
      );
    }
    const [{ count: shipmentsBefore }, { data: inventoryBefore }] = await Promise.all([
      admin.from('shipments').select('id', { count: 'exact', head: true }),
      admin
        .from('inventory')
        .select('quantity_on_hand')
        .eq('product_id', receivingInventory.product_id)
        .single(),
    ]);
    const { data: rejectionSupplier, error: rejectionSupplierError } = await admin
      .from('suppliers')
      .insert({ name: `E2E Soak Rejection Supplier ${randomUUID()}` })
      .select('id')
      .single();
    if (rejectionSupplierError || !rejectionSupplier)
      throw new Error(rejectionSupplierError?.message ?? 'Rejection supplier missing');
    const tamperedReceiving = await admin.rpc('receive_shipment', {
      p_staff_id: manager.id,
      p_supplier_id: rejectionSupplier.id,
      p_items: [
        {
          product_id: receivingInventory.product_id,
          quantity: 2,
          cost_price: 1,
          expiry_date: null,
        },
        { product_id: randomUUID(), quantity: 1, cost_price: 1, expiry_date: null },
      ],
    });
    expect(tamperedReceiving.error).toBeNull();
    expect(tamperedReceiving.data).toMatchObject({ ok: false, code: 'PRODUCT_NOT_FOUND' });
    const [{ count: shipmentsAfter }, { data: inventoryAfter }] = await Promise.all([
      admin.from('shipments').select('id', { count: 'exact', head: true }),
      admin
        .from('inventory')
        .select('quantity_on_hand')
        .eq('product_id', receivingInventory.product_id)
        .single(),
    ]);
    expect(shipmentsAfter).toBe(shipmentsBefore);
    expect(inventoryAfter?.quantity_on_hand).toBe(inventoryBefore?.quantity_on_hand);

    const barcode = `990${String(Date.now()).slice(-10)}`;
    await admin.from('products').update({ barcode }).eq('id', saleProduct.id);
    // The product list is a 5-minute-staleTime TanStack Query cache with no
    // realtime subscription (useProducts()) — a direct admin-client barcode
    // write is invisible to the already-mounted page until it refetches, so
    // reload via gotoAuthed first (same pattern used below for the
    // sold_by_weight toggle). A scan also only ever populates the search box
    // (CheckoutPanel.tsx: "never adds to the cart by itself") — it never
    // auto-adds, so the product still needs an explicit Select click.
    await gotoAuthed(page, '/pos');
    await expect(page.getByPlaceholder(/search products/i)).toBeVisible({ timeout: 15_000 });
    await scanBarcode(page, barcode);
    await expect(
      page.getByRole('button', { name: /select mdh garam masala 100g/i })
    ).toBeVisible();
    await page.getByRole('button', { name: /select mdh garam masala 100g/i }).click();
    let cashBeforeCheckout = await cashSalesForCaja(admin);
    await payCash(page);
    totalCashCollected += (await cashSalesForCaja(admin)) - cashBeforeCheckout;
    // Restore the product's real seeded barcode (Rule 1 fix — this used to
    // null it out permanently instead, corrupting any other spec file that
    // relies on this shared seed product's barcode being set, e.g.
    // e2e/checkout/peek-window.spec.ts).
    await admin.from('products').update({ barcode: saleProduct.barcode }).eq('id', saleProduct.id);

    await page.getByPlaceholder(/search products/i).fill('Parle-G Biscuits 200g');
    await page.getByRole('button', { name: /select parle-g biscuits 200g/i }).click();
    cashBeforeCheckout = await cashSalesForCaja(admin);
    await payCash(page);
    totalCashCollected += (await cashSalesForCaja(admin)) - cashBeforeCheckout;

    await admin
      .from('products')
      .update({ sold_by_weight: true })
      .eq('name', 'Parle-G Biscuits 200g');
    const { data: saleProduct2, error: saleProduct2Error } = await admin
      .from('products')
      .select('id')
      .eq('name', 'Parle-G Biscuits 200g')
      .single();
    if (saleProduct2Error || !saleProduct2)
      throw new Error(saleProduct2Error?.message ?? 'Parle-G Biscuits 200g not found');
    await admin
      .from('inventory')
      .update({ quantity_on_hand: 10_000 })
      .eq('product_id', saleProduct2.id);
    await gotoAuthed(page, '/pos');
    await expect(page.getByPlaceholder(/search products/i)).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder(/search products/i).fill('Parle-G Biscuits 200g');
    await page.getByRole('button', { name: /select parle-g biscuits 200g/i }).click();
    await page.getByRole('button', { name: '1' }).click();
    await page.getByRole('button', { name: '.', exact: true }).click();
    await page.getByRole('button', { name: '0' }).click();
    await page.getByRole('button', { name: /add to cart/i }).click();
    cashBeforeCheckout = await cashSalesForCaja(admin);
    await payCash(page);
    totalCashCollected += (await cashSalesForCaja(admin)) - cashBeforeCheckout;
    await admin
      .from('products')
      .update({ sold_by_weight: false })
      .eq('name', 'Parle-G Biscuits 200g');

    const looseName = await createOpenUnitProduct(admin);
    await logout(page);
    await loginAs(page, 'manager');
    await gotoAuthed(page, '/inventory');
    await page.getByRole('tab', { name: 'Open Units' }).click();
    await page
      .getByLabel('Open a new unit')
      .selectOption({ label: looseName.replace('Loose', 'Box') });
    await page.getByRole('button', { name: 'Open new unit' }).click();
    await expect(page.getByText(/new unit opened/i)).toBeVisible({ timeout: 15_000 });
    await logout(page);
    await loginAs(page, 'cashier');
    await gotoAuthed(page, '/pos');
    await page.getByPlaceholder(/search products/i).fill(looseName);
    await page.getByRole('button', { name: new RegExp(`select ${looseName}`, 'i') }).click();
    cashBeforeCheckout = await cashSalesForCaja(admin);
    await payCash(page);
    totalCashCollected += (await cashSalesForCaja(admin)) - cashBeforeCheckout;

    await page.getByPlaceholder(/search products/i).fill('MDH Garam Masala 100g');
    await page.getByRole('button', { name: /select mdh garam masala 100g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/split payment/i).click();
    const cashBeforeSplit = await cashSalesForCaja(admin);
    const splitCash = Math.round((bulkAmount / 2) * 100) / 100;
    const splitCard = Math.round((bulkAmount - splitCash) * 100) / 100;
    await page
      .getByTestId('split-payment-btn-card')
      .last()
      .click();
    const amountInputs = page.getByLabel(/amount$/i);
    await amountInputs.nth(0).fill(splitCash.toFixed(2));
    await amountInputs.nth(1).fill(splitCard.toFixed(2));
    await page.getByLabel(/amount tendered/i).fill(splitCash.toFixed(2));
    await page.getByRole('button', { name: /process split payment/i }).click();
    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /done/i }).click();
    totalCashCollected += (await cashSalesForCaja(admin)) - cashBeforeSplit;

    const { data: thresholdSetting } = await admin
      .from('settings')
      .select('value')
      .eq('key', 'nearExpiry')
      .maybeSingle();
    const threshold =
      (thresholdSetting?.value as { thresholdDays?: number } | null)?.thresholdDays ?? 14;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + threshold - 2);
    const supplierName = `E2E Soak Supplier ${randomUUID()}`;
    const { data: supplier, error: supplierError } = await admin
      .from('suppliers')
      .insert({ name: supplierName })
      .select('id')
      .single();
    if (supplierError || !supplier)
      throw new Error(supplierError?.message ?? 'Unable to create supplier');
    await logout(page);
    await loginAs(page, 'manager');
    await gotoAuthed(page, '/suppliers');
    await page.getByRole('button', { name: /receive shipment|recibir/i }).click();
    // Scoped to the dialog: an unscoped getByLabel(/supplier/i) also matches the
    // sidebar's "Suppliers" nav link (aria-label="Suppliers"), causing a strict-mode
    // violation now that the app-shell sidebar renders on every authenticated page.
    const receiveShipmentDialog = page.getByRole('dialog', {
      name: /confirm receipt|confirmar recepción/i,
    });
    const supplierSelect = receiveShipmentDialog.getByLabel(/supplier|proveedor/i);
    await expect(supplierSelect).toBeVisible();
    await supplierSelect.selectOption({ label: supplierName });
    await page.getByRole('button', { name: /add line item|agregar partida/i }).click();
    await page.getByLabel(/product|producto/i).fill('Parle-G Biscuits 200g');
    await page.getByLabel(/quantity|cantidad/i).fill('2');
    await page.getByLabel(/cost price|costo/i).fill('1.50');
    await page
      .getByLabel(/expiry date|fecha de caducidad/i)
      .fill(expiry.toISOString().slice(0, 10));
    const { data: inventoryBeforeReceipt, error: inventoryBeforeReceiptError } = await admin
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', saleProduct2.id)
      .single();
    if (inventoryBeforeReceiptError || !inventoryBeforeReceipt) {
      throw new Error(
        inventoryBeforeReceiptError?.message ?? 'Parle-G Biscuits inventory not found before receipt'
      );
    }
    const receiptResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        response.url().includes('/functions/v1/receive-shipment')
    );
    await page.getByRole('button', { name: /confirm receipt|confirmar recepción/i }).click();
    const receiptPayload = (await (await receiptResponse).json()) as {
      shipmentId?: string;
      success?: boolean;
    };
    expect(receiptPayload.success).toBe(true);
    expect(receiptPayload.shipmentId).toEqual(expect.any(String));
    const { data: inventoryAfterReceipt, error: inventoryAfterReceiptError } = await admin
      .from('inventory')
      .select('quantity_on_hand, expiry_date')
      .eq('product_id', saleProduct2.id)
      .single();
    if (inventoryAfterReceiptError || !inventoryAfterReceipt) {
      throw new Error(
        inventoryAfterReceiptError?.message ?? 'Parle-G Biscuits inventory not found after receipt'
      );
    }
    expect(Number(inventoryAfterReceipt.quantity_on_hand)).toBe(
      Number(inventoryBeforeReceipt.quantity_on_hand) + 2
    );
    expect(inventoryAfterReceipt.expiry_date).toBe(expiry.toISOString().slice(0, 10));

    await gotoAuthed(page, '/home');
    await expect(page.getByTestId('home-near-expiry-badge')).toBeVisible({ timeout: 30_000 });
    expect(
      Number(await page.getByTestId('home-near-expiry-badge').innerText())
    ).toBeGreaterThanOrEqual(1);

    await gotoAuthed(page, '/staff');
    await page.getByRole('button', { name: 'Close Caja' }).click();
    const closingCash = Math.round((500 + totalCashCollected) * 100) / 100;
    const closeDialog = page.getByRole('dialog', { name: 'Close Caja' });
    await closeDialog.getByLabel(/closing cash count/i).fill(closingCash.toFixed(2));
    const closeResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && response.url().includes('/rpc/close_caja_session')
    );
    await closeDialog.getByRole('button', { name: 'Close Caja' }).click();
    const closePayload = (await (await closeResponse).json()) as {
      cashReconciliation?: Record<string, number>;
      ok?: boolean;
    };
    expect(closePayload.ok).toBe(true);
    expect(closePayload.cashReconciliation?.openingCash).toBe(500);
    expect(closePayload.cashReconciliation?.cashSales).toBeCloseTo(totalCashCollected, 2);
    expect(closePayload.cashReconciliation?.expectedCash).toBe(closingCash);
    expect(closePayload.cashReconciliation?.closingCash).toBe(closingCash);
    expect(closePayload.cashReconciliation?.variance).toBe(0);
    await expect(page.getByRole('button', { name: 'Open Caja' })).toBeVisible({ timeout: 30_000 });
  });

  test('closing an already-closed caja session is a no-op', async ({ page }) => {
    requireIntegrationEnv();
    const admin = getServiceClient();
    // p_closed_by must match the auth token's own identity below
    // (loginAs(page, 'manager') signs in as the E2E_MANAGER_NAME account) —
    // an arbitrary `role = 'manager'` row can instead resolve to one of the
    // many throwaway `__*_test_manager__` fixture profiles other specs
    // leave behind, which would make close_caja_session reject on identity
    // mismatch (PERMISSION_DENIED) before it ever reaches the NOT_FOUND
    // check this test is actually verifying.
    const { data: manager, error: managerError } = await admin
      .from('profiles')
      .select('id')
      .eq('name', process.env['E2E_MANAGER_NAME'] ?? '')
      .single();
    if (managerError || !manager) throw new Error(managerError?.message ?? 'Manager not found');
    const { data: before, error: beforeError } = await admin
      .from('caja_sessions')
      .select('closing_cash, closed_at')
      .eq('id', cajaSessionId)
      .single();
    if (beforeError || !before) throw new Error(beforeError?.message ?? 'Closed caja not found');
    await page.goto('/');
    await loginAs(page, 'manager');
    const result = await page.evaluate(
      async ({ cajaId, managerId, url, anonKey }) => {
        const key = Object.keys(localStorage).find(item => item.includes('auth-token'));
        const stored = key ? localStorage.getItem(key) : null;
        const token = stored
          ? (JSON.parse(stored) as { access_token?: string }).access_token
          : undefined;
        const response = await fetch(`${url}/rest/v1/rpc/close_caja_session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ p_caja_id: cajaId, p_closed_by: managerId, p_closing_cash: 0 }),
        });
        return response.json();
      },
      {
        cajaId: cajaSessionId,
        managerId: manager.id,
        url: process.env.VITE_SUPABASE_URL ?? '',
        anonKey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
      }
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const { data: after, error: afterError } = await admin
      .from('caja_sessions')
      .select('closing_cash, closed_at')
      .eq('id', cajaSessionId)
      .single();
    if (afterError || !after)
      throw new Error(afterError?.message ?? 'Closed caja missing after replay');
    expect(after).toEqual(before);
  });

  test('closing a caja session with a mismatched p_closed_by is rejected', async ({ page }) => {
    requireIntegrationEnv();
    const admin = getServiceClient();
    const cajaId = await openCaja(100);
    const [
      { data: manager, error: managerError },
      { data: otherProfile, error: otherProfileError },
    ] = await Promise.all([
      admin.from('profiles').select('id').eq('role', 'manager').limit(1).single(),
      admin.from('profiles').select('id').eq('role', 'admin').limit(1).single(),
    ]);
    if (managerError || !manager || otherProfileError || !otherProfile) {
      throw new Error(
        managerError?.message ?? otherProfileError?.message ?? 'Test profiles not found'
      );
    }

    await page.goto('/');
    await loginAs(page, 'manager');
    const result = await page.evaluate(
      async ({ cajaId, closedBy, url, anonKey }) => {
        const key = Object.keys(localStorage).find(item => item.includes('auth-token'));
        const stored = key ? localStorage.getItem(key) : null;
        const token = stored
          ? (JSON.parse(stored) as { access_token?: string }).access_token
          : undefined;
        const response = await fetch(`${url}/rest/v1/rpc/close_caja_session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ p_caja_id: cajaId, p_closed_by: closedBy, p_closing_cash: 0 }),
        });
        return response.json();
      },
      {
        cajaId,
        closedBy: otherProfile.id,
        url: process.env.VITE_SUPABASE_URL ?? '',
        anonKey: process.env.VITE_SUPABASE_ANON_KEY ?? '',
      }
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const { data: caja, error: cajaError } = await admin
      .from('caja_sessions')
      .select('status, closed_by')
      .eq('id', cajaId)
      .single();
    if (cajaError || !caja) throw new Error(cajaError?.message ?? 'Caja session not found');
    expect(caja).toMatchObject({ status: 'open', closed_by: null });
  });
});

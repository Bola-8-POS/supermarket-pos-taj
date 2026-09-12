import { expect, test } from '../fixtures';
import { loginAs } from '../helpers/auth';
import { assertPaymentRecorded, assertStockMovement } from '../helpers/db-assertions';
import { getInventoryQty, getServiceClient, openCaja, resetTestState } from '../helpers/supabase';
import { getBillingTaxConfig, computeAuthoritativeTotal } from '../helpers/tax';
import { requireIntegrationEnv } from '../helpers/requireEnv';

let cajaSessionId = '';

test.describe('Direct-sale checkout', () => {
  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    cajaSessionId = await openCaja(500);
    await page.goto('/');
    await loginAs(page, 'cashier');
  });

  test('cash payment creates one paid sale and decrements stock', async ({ page }) => {
    const quantityBefore = await getInventoryQty("Haldiram's Aloo Bhujia 200g");

    await page.getByRole('button', { name: /checkout/i }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/amount tendered/i).fill('100');
    await page
      .getByRole('button', { name: /^process payment$/i })
      .last()
      .click();

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /done/i }).click();
    await expect(page.getByText(/cart is empty/i)).toBeVisible();
    await expect
      .poll(() => getInventoryQty("Haldiram's Aloo Bhujia 200g"))
      .toBe(quantityBefore - 1);

    const admin = getServiceClient();
    const { data: product, error: productError } = await admin
      .from('products')
      .select('base_price')
      .eq('name', "Haldiram's Aloo Bhujia 200g")
      .single();
    if (productError || !product) throw new Error(productError?.message ?? 'Product not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    const expectedTotal = computeAuthoritativeTotal(Number(product.base_price), taxRatePercent, taxInclusive);
    const { data: tabs, error: tabsError } = await admin
      .from('tabs')
      .select('id, status')
      .order('created_at', { ascending: false })
      .limit(1);
    if (tabsError || !tabs?.[0]) throw new Error(tabsError?.message ?? 'Tab not found');
    expect(tabs[0].status).toBe('paid');

    const [{ data: payments, error: paymentsError }, { data: orders, error: ordersError }] =
      await Promise.all([
        admin.from('payments').select('method, amount').eq('tab_id', tabs[0].id),
        admin.from('orders').select('id').eq('tab_id', tabs[0].id),
      ]);
    if (paymentsError || !payments) throw new Error(paymentsError?.message ?? 'Payments not found');
    if (ordersError || !orders) throw new Error(ordersError?.message ?? 'Orders not found');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'cash' });
    expect(Number(payments[0].amount)).toBeCloseTo(expectedTotal, 2);
    expect(orders).toHaveLength(1);
    const { data: productWithId, error: productIdError } = await admin
      .from('products')
      .select('id')
      .eq('name', "Haldiram's Aloo Bhujia 200g")
      .single();
    if (productIdError || !productWithId) {
      throw new Error(productIdError?.message ?? 'Product not found');
    }
    await assertStockMovement(productWithId.id, -1, 'sale');
    await assertPaymentRecorded(tabs[0].id, expectedTotal, 'cash');
  });

  test('cancelling before payment preserves the cart', async ({ page }) => {
    await page.getByRole('button', { name: /checkout/i }).click();
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByRole('button', { name: /^cancel$/i }).click();

    await expect(page.locator('aside').getByText("Haldiram's Aloo Bhujia 200g")).toBeVisible();
    await expect(page.getByText(/sale complete/i)).not.toBeVisible();
  });

  test('offline before checkout submit shows blocking dialog instead of hanging', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /checkout/i }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/amount tendered/i).fill('100');

    const requestPromise = page
      .waitForRequest(req => req.url().includes('/process-direct-sale'), { timeout: 5_000 })
      .then(
        () => 'requested',
        () => 'not-requested'
      );

    await page.context().setOffline(true);
    await page
      .getByRole('button', { name: /^process payment$/i })
      .last()
      .click();

    const dialog = page.getByRole('alertdialog').filter({ hasText: /offline/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => requestPromise, { timeout: 5_500 }).toBe('not-requested');

    await page.context().setOffline(false);
  });

  test('Try Again after reconnecting completes the sale', async ({ page }) => {
    await page.getByRole('button', { name: /checkout/i }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/amount tendered/i).fill('100');

    await page.context().setOffline(true);
    await page
      .getByRole('button', { name: /^process payment$/i })
      .last()
      .click();

    const dialog = page.getByRole('alertdialog').filter({ hasText: /offline/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await page.context().setOffline(false);
    await dialog.getByRole('button', { name: /try again/i }).click();

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
  });

  test('Cancel on offline dialog returns to cart without submitting', async ({ page }) => {
    await page.getByRole('button', { name: /checkout/i }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByLabel(/amount tendered/i).fill('100');

    await page.context().setOffline(true);
    await page
      .getByRole('button', { name: /^process payment$/i })
      .last()
      .click();

    const dialog = page.getByRole('alertdialog').filter({ hasText: /offline/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /^cancel$/i }).click();
    await expect(dialog).toBeHidden();

    await page.context().setOffline(false);
    await expect(page.getByLabel(/amount tendered/i)).toBeVisible();
    await expect(page.getByLabel(/amount tendered/i)).toHaveValue('100.00');
  });

  test('card payment creates one paid sale and decrements stock', async ({ page }) => {
    const quantityBefore = await getInventoryQty("Haldiram's Aloo Bhujia 200g");

    await page.getByRole('button', { name: /checkout/i }).click();
    await page.getByPlaceholder(/search products/i).fill("Haldiram's Aloo Bhujia 200g");
    await page.getByRole('button', { name: /select haldiram's aloo bhujia 200g/i }).click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
    await page.getByTestId('payment-btn-card').click();
    await page.getByRole('button', { name: /confirm card payment/i }).click();

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => getInventoryQty("Haldiram's Aloo Bhujia 200g"))
      .toBe(quantityBefore - 1);
  });

  test('split cash and card payment creates two grouped payments and decrements stock once', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const quantityBefore = await getInventoryQty("Haldiram's Aloo Bhujia 200g");
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
    await page.getByRole('button', { name: /process split payment/i }).click();

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    const { data: payments, error: paymentsError } = await admin
      .from('payments')
      .select('payment_group_id, split_index, method')
      .not('payment_group_id', 'is', null)
      .order('processed_at', { ascending: false })
      .limit(2);
    if (paymentsError || !payments) throw new Error(paymentsError?.message ?? 'Payments not found');
    expect(payments).toHaveLength(2);
    expect(new Set(payments.map(payment => payment.payment_group_id)).size).toBe(1);
    expect(payments.map(payment => payment.split_index).sort()).toEqual([0, 1]);
    expect(new Set(payments.map(payment => payment.method))).toEqual(new Set(['cash', 'card']));
    await expect
      .poll(() => getInventoryQty("Haldiram's Aloo Bhujia 200g"))
      .toBe(quantityBefore - 1);
  });
});

/**
 * E2E spec: Direct-sale checkout — platform tenders (Rappi / Uber Eats)
 * (feat/configurable-payment-methods).
 *
 * rappi and uber_eats are now plain "platform tenders" behaving exactly like
 * card: optional free-text reference, taxed like card (the old Rappi
 * zero-tax carve-out was deleted), tendered_amount is always NULL on the
 * `payments` row. Mirrors e2e/checkout/tax-inclusive-mode.spec.ts's flow
 * (search → select → Process Payment) and happy-path.spec.ts's split-payment
 * assertions.
 */
import { expect, test, type Page } from '../fixtures';
import { loginAs } from '../helpers/auth';
import { getInventoryQty, getServiceClient, openCaja, resetTestState } from '../helpers/supabase';
import { getBillingTaxConfig, computeAuthoritativeTotal } from '../helpers/tax';
import { requireIntegrationEnv } from '../helpers/requireEnv';

const PRODUCT_NAME = "Haldiram's Aloo Bhujia 200g";

type DirectSaleReceipt = {
  tabId: string;
  paymentMethod: string;
  taxAmount: number;
  terminalReference?: string | null;
};

type DirectSaleResponseBody = {
  success: boolean;
  receiptData?: DirectSaleReceipt;
};

let cajaSessionId = '';

test.describe('Direct-sale checkout — platform tenders (rappi / uber_eats)', () => {
  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    cajaSessionId = await openCaja(500);
    await page.goto('/');
    await loginAs(page, 'cashier');
  });

  async function addProductAndOpenPayment(page: Page): Promise<void> {
    await page.getByRole('button', { name: /checkout/i }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByPlaceholder(/search products/i).fill(PRODUCT_NAME);
    await page
      .getByRole('button', { name: new RegExp(`select ${PRODUCT_NAME}`, 'i') })
      .click();
    await page
      .getByRole('button', { name: /^process payment$/i })
      .first()
      .click();
  }

  test('rappi payment charges tax like card, stores no tendered amount, and decrements stock once', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const quantityBefore = await getInventoryQty(PRODUCT_NAME);

    await addProductAndOpenPayment(page);
    await page.getByTestId('payment-btn-rappi').click();
    await page.getByLabel(/reference/i).fill('RAPPI-12345');

    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/functions/v1/process-direct-sale') && resp.status() === 200
    );
    await page.getByRole('button', { name: /confirm card payment/i }).click();
    const response = await responsePromise;
    const body = (await response.json()) as DirectSaleResponseBody;
    if (!body.receiptData) throw new Error('process-direct-sale response had no receiptData');

    expect(body.success).toBe(true);
    expect(body.receiptData.paymentMethod).toBe('rappi');
    expect(body.receiptData.taxAmount).toBeGreaterThan(0);
    expect(body.receiptData.terminalReference).toBe('RAPPI-12345');

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /done/i }).click();

    const { data: payment, error } = await admin
      .from('payments')
      .select('method, tendered_amount, reference_number')
      .eq('tab_id', body.receiptData.tabId)
      .single();
    if (error || !payment) throw new Error(error?.message ?? 'Payment row not found');
    expect(payment.method).toBe('rappi');
    expect(payment.tendered_amount).toBeNull();
    expect(payment.reference_number).toBe('RAPPI-12345');

    await expect.poll(() => getInventoryQty(PRODUCT_NAME)).toBe(quantityBefore - 1);
  });

  test('uber_eats payment charges tax like card, stores no tendered amount, and decrements stock once', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const quantityBefore = await getInventoryQty(PRODUCT_NAME);

    await addProductAndOpenPayment(page);
    await page.getByTestId('payment-btn-uber-eats').click();
    await page.getByLabel(/reference/i).fill('UBEREATS-98765');

    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/functions/v1/process-direct-sale') && resp.status() === 200
    );
    await page.getByRole('button', { name: /confirm card payment/i }).click();
    const response = await responsePromise;
    const body = (await response.json()) as DirectSaleResponseBody;
    if (!body.receiptData) throw new Error('process-direct-sale response had no receiptData');

    expect(body.success).toBe(true);
    expect(body.receiptData.paymentMethod).toBe('uber_eats');
    expect(body.receiptData.taxAmount).toBeGreaterThan(0);
    expect(body.receiptData.terminalReference).toBe('UBEREATS-98765');

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /done/i }).click();

    const { data: payment, error } = await admin
      .from('payments')
      .select('method, tendered_amount, reference_number')
      .eq('tab_id', body.receiptData.tabId)
      .single();
    if (error || !payment) throw new Error(error?.message ?? 'Payment row not found');
    expect(payment.method).toBe('uber_eats');
    expect(payment.tendered_amount).toBeNull();
    expect(payment.reference_number).toBe('UBEREATS-98765');

    await expect.poll(() => getInventoryQty(PRODUCT_NAME)).toBe(quantityBefore - 1);
  });

  test('split payment: cash + uber_eats creates two grouped payments and decrements stock once', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const quantityBefore = await getInventoryQty(PRODUCT_NAME);
    const { data: product, error: productError } = await admin
      .from('products')
      .select('base_price')
      .eq('name', PRODUCT_NAME)
      .single();
    if (productError || !product) throw new Error(productError?.message ?? 'Product not found');
    const { taxRatePercent, taxInclusive } = await getBillingTaxConfig(admin);
    const total = computeAuthoritativeTotal(Number(product.base_price), taxRatePercent, taxInclusive);
    const cashAmount = Math.round((total / 2) * 100) / 100;
    const uberEatsAmount = Math.round((total - cashAmount) * 100) / 100;

    await addProductAndOpenPayment(page);
    await page.getByLabel(/split payment/i).click();

    // Both rows default to cash — switch row 2 (last) to uber_eats first, so
    // "Amount tendered" stays unambiguous for row 1 (still cash) below.
    const uberEatsButtons = page.getByTestId('split-payment-btn-uber-eats');
    await uberEatsButtons.last().click();

    const amountInputs = page.getByLabel(/amount$/i);
    await amountInputs.nth(0).fill(cashAmount.toFixed(2));
    await amountInputs.nth(1).fill(uberEatsAmount.toFixed(2));
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
    expect(new Set(payments.map(p => p.payment_group_id)).size).toBe(1);
    expect(payments.map(p => p.split_index).sort()).toEqual([0, 1]);
    expect(new Set(payments.map(p => p.method))).toEqual(new Set(['cash', 'uber_eats']));

    await expect.poll(() => getInventoryQty(PRODUCT_NAME)).toBe(quantityBefore - 1);
  });
});

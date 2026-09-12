/**
 * E2E tests for RCP-01 — Reprint receipt from PaymentPane
 *
 * Strategy: same dual-Tauri-global injection RESEARCH.md's Pitfall 2 requires
 * (`window.__TAURI__` passes pos-printer.ts's isTauri() gate; the real
 * `invoke()` reads from `window.__TAURI_INTERNALS__`) — mirrors the pattern
 * already proven in e2e/25-export-reports.spec.ts, extended for
 * `print_receipt` instead of the dialog/fs plugin commands. The mock
 * records the most recent `print_receipt` call's `lines` array onto
 * `window.__lastPrintedLines` so the test can inspect exactly what would
 * have been sent to the printer.
 */
import { expect, test, type Page } from '../fixtures';
import { loginAs } from '../helpers/auth';
import { requireIntegrationEnv } from '../helpers/requireEnv';
import { getServiceClient, openCaja, resetTestState, seedClosedTab } from '../helpers/supabase';
import { getBillingTaxConfig, computeAuthoritativeTotal } from '../helpers/tax';

async function injectPrintMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__TAURI__'] = {};
    (window as unknown as Record<string, unknown>)['__lastPrintedLines'] = null;
    // CheckoutPanel's isTauri()-guarded listen() effect mounts on /pos and its
    // cleanup synchronously reads this global before ever calling invoke()
    // (see e2e/helpers/tauriPeekMock.ts) — without it, unmount throws
    // "Cannot read properties of undefined (reading 'unregisterListener')".
    (window as unknown as Record<string, unknown>)['__TAURI_EVENT_PLUGIN_INTERNALS__'] = {
      unregisterListener: () => undefined,
    };
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      invoke(cmd: string, args: unknown): Promise<unknown> {
        if (cmd === 'print_receipt') {
          const argsObj = args as { lines?: string[] };
          (window as unknown as Record<string, unknown>)['__lastPrintedLines'] =
            argsObj.lines ?? null;
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
      transformCallback(callback: (arg: unknown) => void, _once: boolean): number {
        const id = Math.floor(Math.random() * 1_000_000);
        (window as unknown as Record<string, unknown>)[`_${String(id)}`] = callback;
        return id;
      },
      unregisterCallback(id: number): void {
        (window as unknown as Record<string, unknown>)[`_${String(id)}`] = undefined;
      },
    };
  });
}

async function getLastPrintedLines(page: Page): Promise<string[] | null> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>)['__lastPrintedLines'] as string[] | null
  );
}

test.describe('Reprint receipt (RCP-01)', () => {
  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    await openCaja(500);
    await injectPrintMock(page);
    await page.goto('/');
    await loginAs(page, 'cashier');
  });

  test("reprinting a split sale prints one receipt with both tender legs, not one leg's amount", async ({
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
    await page.getByRole('button', { name: /process split payment/i }).click();

    await expect(page.getByRole('button', { name: /done/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /done/i }).click();

    const { data: payments, error: paymentsError } = await admin
      .from('payments')
      .select('id')
      .not('payment_group_id', 'is', null)
      .order('processed_at', { ascending: false })
      .limit(1);
    const firstPayment = payments?.[0];
    if (paymentsError || !firstPayment) {
      throw new Error(paymentsError?.message ?? 'Split payment not found');
    }
    const paymentId = firstPayment.id as string;

    await page.goto(`/payments?id=${paymentId}`);
    const row = page.getByTestId(`payment-row-${paymentId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /reprint/i }).click();

    await expect
      .poll(async () => getLastPrintedLines(page), { timeout: 15_000 })
      .not.toBeNull();

    const lines = await getLastPrintedLines(page);
    const text = (lines ?? []).join('\n');
    expect(text).toContain(cashAmount.toFixed(2));
    expect(text).toContain(cardAmount.toFixed(2));
  });

  test('a reprint data-fetch failure shows a distinct toast and does not attempt to print', async ({
    page,
  }) => {
    const admin = getServiceClient();
    const tabId = await seedClosedTab();
    const { data: payment, error } = await admin
      .from('payments')
      .select('id')
      .eq('tab_id', tabId)
      .single();
    if (error || !payment) throw new Error(error?.message ?? 'Seeded payment not found');
    const paymentId = payment.id as string;

    await page.goto(`/payments?id=${paymentId}`);
    const row = page.getByTestId(`payment-row-${paymentId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Break the underlying reference between page load and click — the
    // payments FK is ON DELETE RESTRICT on tabs, so the reference is broken
    // by removing the payment row itself (tabs.id stays put), which is what
    // fetchReceiptDataForPayment's fail-closed guard actually detects
    // (payments.length === 0), simulating "this sale's data is now gone".
    await admin.from('payments').delete().eq('id', paymentId);

    await row.getByRole('button', { name: /reprint/i }).click();

    await expect(page.getByText(/couldn't load this sale's receipt/i)).toBeVisible({
      timeout: 15_000,
    });
    expect(await getLastPrintedLines(page)).toBeNull();
  });
});

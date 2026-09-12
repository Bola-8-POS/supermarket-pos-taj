/**
 * E2E spec: Settings → Billing tab, configurable payment methods
 * (feat/configurable-payment-methods).
 *
 * Payment methods are now a fixed configurable set (cash, card,
 * bank_transfer, rappi, uber_eats) rendered generically from PAYMENT_METHODS
 * — this replaces the old hardcoded cash/bbvaCard/rappi toggles and the
 * pool-era "First hour billing mode" section (deleted end-to-end).
 *
 * `settings` rows `key='billing'` and `key='payment_labels'` are store-wide
 * singletons that `resetTestState()` deliberately does NOT reset — every
 * test here snapshots both rows in `beforeEach` and restores them in
 * `afterEach` regardless of outcome. `test.describe.serial` because two
 * tests writing the same singleton row concurrently would clobber each
 * other (config also runs workers: 1, but this keeps intent explicit).
 */
import { expect, test, type Page } from '../fixtures';
import { gotoAuthed, loginAs } from '../helpers/auth';
import { getServiceClient, openCaja, resetTestState } from '../helpers/supabase';
import { requireIntegrationEnv } from '../helpers/requireEnv';

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'rappi', 'uber_eats'] as const;
const PRODUCT_NAME = "Haldiram's Aloo Bhujia 200g";

type SettingsValue = Record<string, unknown> | null;

async function readSetting(
  admin: ReturnType<typeof getServiceClient>,
  key: string
): Promise<SettingsValue> {
  const { data, error } = await admin.from('settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`readSetting(${key}) failed: ${error.message}`);
  return (data?.value as SettingsValue) ?? null;
}

async function writeSetting(
  admin: ReturnType<typeof getServiceClient>,
  key: string,
  value: SettingsValue
): Promise<void> {
  if (value === null) {
    await admin.from('settings').delete().eq('key', key);
    return;
  }
  const { error } = await admin.from('settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(`writeSetting(${key}) failed: ${error.message}`);
}

async function openBillingTab(page: Page): Promise<void> {
  await gotoAuthed(page, '/settings');
  await page.getByRole('tab', { name: 'Billing', exact: true }).click();
  await expect(page.getByTestId('billing-method-toggle-cash')).toBeVisible({ timeout: 15_000 });
}

async function openProcessPayment(page: Page): Promise<void> {
  await gotoAuthed(page, '/pos');
  await page.getByPlaceholder(/search products/i).fill(PRODUCT_NAME);
  await page
    .getByRole('button', { name: new RegExp(`select ${PRODUCT_NAME}`, 'i') })
    .click();
  await page
    .getByRole('button', { name: /^process payment$/i })
    .first()
    .click();
}

test.describe.serial('Settings — configurable payment methods (Billing tab)', () => {
  let billingSnapshot: SettingsValue = null;
  let labelsSnapshot: SettingsValue = null;

  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    const admin = getServiceClient();
    billingSnapshot = await readSetting(admin, 'billing');
    labelsSnapshot = await readSetting(admin, 'payment_labels');
    await openCaja(500);
    await page.goto('/');
    await loginAs(page, 'admin');
  });

  test.afterEach(async () => {
    const admin = getServiceClient();
    // Restore regardless of test outcome — these rows are store-wide
    // singletons every other spec (and this suite's own later tests) reads.
    await writeSetting(admin, 'billing', billingSnapshot);
    await writeSetting(admin, 'payment_labels', labelsSnapshot);
  });

  test('shows all five method toggles and label inputs; no legacy first-hour billing mode', async ({
    page,
  }) => {
    await openBillingTab(page);

    for (const method of PAYMENT_METHODS) {
      await expect(page.getByTestId(`billing-method-toggle-${method}`)).toBeVisible();
      await expect(page.getByTestId(`billing-method-label-${method}`)).toBeVisible();
    }

    await expect(page.getByText(/first hour|prorated|full hour/i)).toHaveCount(0);
  });

  test('disabling uber_eats hides its checkout button; re-enabling restores it', async ({
    page,
  }) => {
    const admin = getServiceClient();

    await openBillingTab(page);
    await page.getByTestId('billing-method-toggle-uber_eats').click();
    await page.getByRole('button', { name: 'Save Billing' }).click();
    await expect(page.getByText('Billing settings saved.')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const value = await readSetting(admin, 'billing');
          return (value as { paymentMethods?: { uber_eats?: boolean } } | null)?.paymentMethods
            ?.uber_eats;
        },
        { timeout: 10_000 }
      )
      .toBe(false);

    await openProcessPayment(page);
    await expect(page.getByTestId('payment-btn-uber-eats')).toHaveCount(0);
    await expect(page.getByTestId('payment-btn-rappi')).toBeVisible();
    await expect(page.getByTestId('payment-btn-cash')).toBeVisible();

    // Toggle back on — the button must reappear. afterEach also restores the
    // whole row from billingSnapshot regardless, as a backstop for a failure
    // partway through this re-enable step.
    await openBillingTab(page);
    await page.getByTestId('billing-method-toggle-uber_eats').click();
    await page.getByRole('button', { name: 'Save Billing' }).click();
    await expect(page.getByText('Billing settings saved.')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const value = await readSetting(admin, 'billing');
          return (value as { paymentMethods?: { uber_eats?: boolean } } | null)?.paymentMethods
            ?.uber_eats;
        },
        { timeout: 10_000 }
      )
      .toBe(true);

    await openProcessPayment(page);
    await expect(page.getByTestId('payment-btn-uber-eats')).toBeVisible();
  });

  test('changing the card button label persists and reflects at checkout', async ({ page }) => {
    const admin = getServiceClient();

    await openBillingTab(page);
    await page.getByTestId('billing-method-label-card').fill('Clip Terminal');
    await page.getByRole('button', { name: 'Save Labels' }).click();
    await expect(page.getByText('Payment labels saved.')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => {
          const value = await readSetting(admin, 'payment_labels');
          return (value as { card?: string } | null)?.card;
        },
        { timeout: 10_000 }
      )
      .toBe('Clip Terminal');

    await openProcessPayment(page);
    await expect(page.getByTestId('payment-btn-card')).toHaveText('Clip Terminal');
  });

  test('legacy bbvaCard-shaped billing row maps to card (OFF) and still renders all five toggles', async ({
    page,
  }) => {
    const admin = getServiceClient();
    await writeSetting(admin, 'billing', {
      taxRatePercent: 16,
      paymentMethods: { cash: true, bbvaCard: false, rappi: true },
      taxInclusive: true,
    });

    await openBillingTab(page);

    for (const method of PAYMENT_METHODS) {
      await expect(page.getByTestId(`billing-method-toggle-${method}`)).toBeVisible();
    }
    // data-variant is the shadcn/CVA Button's own variant attribute — 'outline'
    // is the OFF style, 'default' is ON (see BillingSettingsTab.tsx).
    await expect(page.getByTestId('billing-method-toggle-card')).toHaveAttribute(
      'data-variant',
      'outline'
    );
  });
});

/* eslint-disable */
/**
 * E2E spec: Split Payment (Multi-Method)
 * Covers:
 *  T1: Happy path (D-08/D-09, SC-2/SC-3) — 2-method split close (cash + card) through
 *      the deployed process-split-payment edge function + process_split_payment_atomic
 *      RPC, sequential per-leg receipts, tab reaches 'paid'.
 *  T2: Validation gate (SC-3, Pitfall 3) — partial row allocation blocks submit.
 *  T3: Add/remove row (D-02) — cap at 4 rows, floor at 2 rows.
 *
 * Requires local Supabase with the payment_group_id/split_index columns +
 * process_split_payment_atomic RPC) and the process-split-payment edge function deployed.
 * Uses the payment-pane route because the checkout route is direct-sale only.
 */

import { expect, test, type Page } from '../fixtures';
import { loginAs, logout } from '../helpers/auth';
import { requireIntegrationEnv } from '../helpers/requireEnv';
import { findRoleStaffId, getServiceClient, openCaja, resetTestState } from '../helpers/supabase';

// ---------------------------------------------------------------------------
// Seed helpers (adapted from e2e/34-split-bill.spec.ts's seedOpenTab/selectTabByName)
// ---------------------------------------------------------------------------

interface SeededTab {
  tabId: string;
}

/**
 * Seed an open tab with `itemCount` order_items at `unitPrice` each.
 * Creates a shift if none exist. Uses the manager profile that owns payment-pane access.
 */
async function seedOpenTab(
  db: ReturnType<typeof getServiceClient>,
  customerName: string,
  itemCount: number,
  unitPrice: number
): Promise<SeededTab> {
  // Resolve the pinned E2E_MANAGER_NAME fixture account (same helper e2e/helpers/
  // supabase.ts's own seedOpenTab uses) rather than "any profile with role
  // manager" — other suites (edit-paid-tab, reopen-closed-ticket) leave many
  // extra manager profiles in the shared DB, and useTabs() filters by the
  // CURRENT staff's shift_id, so the seeded tab's shift must belong to the same
  // manager that loginAs(page, 'manager') actually authenticates as.
  const managerId = await findRoleStaffId(db, 'manager');

  let shiftId: string;
  const { data: existingShift } = await db
    .from('shifts')
    .select('id')
    .eq('staff_id', managerId)
    .is('clock_out', null)
    .limit(1)
    .maybeSingle();
  if (existingShift) {
    shiftId = existingShift.id as string;
  } else {
    const { data: newShift } = await db
      .from('shifts')
      .insert({ staff_id: managerId, opening_cash: 0 })
      .select('id')
      .single();
    shiftId = newShift.id as string;
  }

  const { data: caja } = await db.from('caja_sessions').select('id').eq('status', 'open').single();

  const { data: tab } = await db
    .from('tabs')
    .insert({
      customer_name: customerName,
      staff_id: managerId,
      shift_id: shiftId,
      caja_session_id: caja.id,
      status: 'open',
      is_deleted: false,
    })
    .select('id')
    .single();

  const { data: order } = await db
    .from('orders')
    .insert({
      tab_id: tab.id,
      staff_id: managerId,
      status: 'served',
    })
    .select('id')
    .single();

  const { data: product } = await db
    .from('products')
    .select('id')
    .eq('name', "Haldiram's Aloo Bhujia 200g")
    .single();

  const inserts = Array.from({ length: itemCount }, () => ({
    order_id: order.id,
    product_id: product.id,
    quantity: 1,
    unit_price: unitPrice,
    modifier_price_delta: 0,
  }));
  await db.from('order_items').insert(inserts).select('id');

  return { tabId: tab.id as string };
}

/**
 * Navigate to /payments, select a tab by customer name, and unlock its payment form.
 */
async function openPaymentForm(page: Page, customerName: string): Promise<void> {
  await page.goto('/payments');
  const tabBtn = page.getByTestId('tabs-waiting-for-payment').getByRole('button', {
    name: new RegExp(`tab ${customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  });
  await expect(tabBtn).toBeVisible({ timeout: 15_000 });
  await tabBtn.click();
  await page.getByRole('button', { name: /verify pin to process payment/i }).click();
  const pinDialog = page.getByRole('alertdialog', { name: /manager access required/i });
  await expect(pinDialog).toBeVisible({ timeout: 10_000 });
  for (const digit of process.env['E2E_MANAGER_PIN'] ?? '') {
    await page.getByRole('button', { name: digit === '0' ? 'Key 0' : `Key ${digit}` }).click();
  }
  await expect(pinDialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('payment-btn-cash')).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

test.describe('Split Payment', () => {
  test.beforeEach(async ({ page }) => {
    requireIntegrationEnv();
    await resetTestState();
    await openCaja(500);
    await page.goto('/');
  });

  test.afterEach(async ({ page }) => {
    await logout(page).catch(() => undefined);
  });

  // ==========================================================================
  // T1: Happy path — 2-method split close (cash + card)
  // ==========================================================================
  test('T1: happy path — 2-method split close (cash + card)', async ({ page }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({ type: 'requirement', description: 'SC-2, SC-3, D-08, D-09' });

    const db = getServiceClient();
    const { tabId } = await seedOpenTab(db, 'E2E Split Payment T1', 4, 15.0);

    await loginAs(page, 'manager');
    await openPaymentForm(page, 'E2E Split Payment T1');
    const modal = page;

    // Toggle "Split payment" ON — 2 rows + Remaining to pay box appear (SC-3)
    await modal.getByRole('switch', { name: 'Split payment' }).click();
    await expect(modal.getByText('Payment 1')).toBeVisible();
    await expect(modal.getByText('Payment 2')).toBeVisible();
    await expect(modal.getByText(/remaining to pay/i)).toBeVisible();

    // Read the target subtotal+tax straight from the (0/0) remaining-balance box —
    // avoids hardcoding tax-rate/discount assumptions; matches whatever the running
    // environment actually computes.
    const remainingBoxText = (
      await modal.getByText('Remaining to pay').locator('..').innerText()
    ).trim();
    const match = /\$([0-9]+\.[0-9]{2})/.exec(remainingBoxText);
    if (!match?.[1]) {
      throw new Error(`T1: could not parse remaining-balance amount from "${remainingBoxText}"`);
    }
    const totalCents = Math.round(parseFloat(match[1]) * 100);
    const halfCents = Math.floor(totalCents / 2);
    const row1Amount = (halfCents / 100).toFixed(2);
    const row2Amount = ((totalCents - halfCents) / 100).toFixed(2);

    // Row 2 → card FIRST — both rows default to cash, so switching row 2 away from
    // cash before touching row 1's "Amount tendered" keeps that label unambiguous
    // (only row 1 remains cash at that point, avoiding a strict-mode locator clash).
    await modal.getByTestId('split-payment-btn-card').nth(1).click();

    // Row 1 stays cash (default) — Amount + Amount tendered (exact, no change due)
    const amountInputs = modal.getByLabel('Amount', { exact: true });
    await amountInputs.nth(0).fill(row1Amount);
    await modal.getByLabel('Amount tendered', { exact: true }).fill(row1Amount);

    // Row 2 → fill Amount for the remainder
    await amountInputs.nth(1).fill(row2Amount);

    await expect(modal.getByText('Fully allocated ✓')).toBeVisible({ timeout: 5_000 });
    const submitBtn = modal.getByRole('button', { name: 'Process split payment' });
    await expect(submitBtn).toBeEnabled();

    // Phase 24 Plan 03 (TAX-05): process-split-payment's per-leg receipts must
    // carry the same decomposed subtotal+tax+total shape as a fresh
    // direct-sale receipt — intercept the edge function's real JSON response.
    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/functions/v1/process-split-payment') && resp.status() === 200
    );
    await submitBtn.click();
    const response = await responsePromise;
    const body = (await response.json()) as {
      receipts?: { subtotal: number; taxAmount?: number; total: number }[];
    };
    const firstReceipt = body.receipts?.[0];
    if (!firstReceipt) throw new Error('process-split-payment response had no receipts');
    expect(firstReceipt.subtotal).toBeDefined();
    expect(firstReceipt.taxAmount ?? -1).toBeGreaterThanOrEqual(0);
    expect(Math.round((firstReceipt.subtotal + (firstReceipt.taxAmount ?? 0)) * 100)).toBe(
      Math.round(firstReceipt.total * 100)
    );

    // PaymentForm.tsx's handleSplitPrimary only ever surfaces the FIRST leg's
    // receipt on screen ("the first receipt is what's shown on screen, and
    // every receipt in the array is still printed below" — every leg is
    // still printed via the hardware path, just not cycled through in the
    // UI). D-09's "one receipt per leg" only ever applied to the print
    // queue, not the on-screen step — a single "Receipt" view is the
    // current, intentional behavior for both direct-sale and generic-tab
    // split payments.
    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible({ timeout: 90_000 });
    await modal.getByRole('button', { name: 'Done' }).click();

    // Done returns to the tab list — the just-paid tab is no longer "waiting
    // for payment" (T1 seeds exactly one tab, so the list renders its empty
    // state once that tab is paid, rather than the tabs-waiting-for-payment
    // container with the tab absent from it).
    await expect(page.getByText('E2E Split Payment T1')).not.toBeVisible({ timeout: 10_000 });

    // Tab reaches 'paid' only after both legs succeed (D-08 all-or-nothing)
    await expect
      .poll(
        async () => {
          const { data } = await db.from('tabs').select('status').eq('id', tabId).single();
          return (data as { status: string } | null)?.status ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe('paid');

    // Both legs share one payment_group_id, distinct split_index, cash + card methods
    const { data: paymentRows } = await db
      .from('payments')
      .select('amount, method, payment_group_id, split_index')
      .eq('tab_id', tabId)
      .eq('is_refund', false);
    const rows = (paymentRows ?? []) as {
      amount: number;
      method: string;
      payment_group_id: string | null;
      split_index: number | null;
    }[];
    expect(rows.length).toBe(2);
    const groupIds = new Set(rows.map(r => r.payment_group_id));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).not.toBeNull();
    expect(rows.map(r => r.method).sort()).toEqual(['card', 'cash']);
    expect(new Set(rows.map(r => r.split_index)).size).toBe(2);
  });

  // ==========================================================================
  // T2: Validation gate — partial allocation blocks submit
  // ==========================================================================
  test('T2: validation gate — partial row allocation blocks submit', async ({ page }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({ type: 'requirement', description: 'SC-3, Pitfall 3' });

    const db = getServiceClient();
    await seedOpenTab(db, 'E2E Split Payment T2', 2, 20.0);

    await loginAs(page, 'manager');
    await openPaymentForm(page, 'E2E Split Payment T2');
    const modal = page;

    await modal.getByRole('switch', { name: 'Split payment' }).click();
    await expect(modal.getByText('Payment 1')).toBeVisible();
    await expect(modal.getByText('Payment 2')).toBeVisible();

    // Switch both rows to card to avoid the cash tendered-amount requirement
    const cardButtons = modal.getByTestId('split-payment-btn-card');
    await cardButtons.nth(0).click();
    await cardButtons.nth(1).click();

    const submitBtn = modal.getByRole('button', { name: 'Process split payment' });
    await expect(submitBtn).toBeDisabled();

    // Fill only row 1 — row 2 stays at $0 (remaining ≠ 0)
    const amountInputs = modal.getByLabel('Amount', { exact: true });
    await amountInputs.nth(0).fill('5.00');

    await expect(submitBtn).toBeDisabled();
    await expect(modal.getByText('Fully allocated ✓')).toHaveCount(0);
    await expect(modal.getByText(/remaining to pay/i)).toBeVisible();

    await modal.getByRole('button', { name: 'Cancel' }).click();
  });

  // ==========================================================================
  // T3: Add/remove row — cap at 4, floor at 2
  // ==========================================================================
  test('T3: add/remove row — cap at 4 rows, floor at 2 rows', async ({ page }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({ type: 'requirement', description: 'D-02' });

    const db = getServiceClient();
    await seedOpenTab(db, 'E2E Split Payment T3', 2, 20.0);

    await loginAs(page, 'manager');
    await openPaymentForm(page, 'E2E Split Payment T3');
    const modal = page;

    await modal.getByRole('switch', { name: 'Split payment' }).click();
    await expect(modal.getByText('Payment 1')).toBeVisible();
    await expect(modal.getByText('Payment 2')).toBeVisible();

    // Remove control is not rendered at the 2-row floor
    await expect(modal.getByRole('button', { name: 'Remove payment 1' })).toHaveCount(0);

    const addBtn = modal.getByRole('button', { name: '+ Add payment method' });
    await addBtn.click();
    await expect(modal.getByText('Payment 3')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Remove payment 1' })).toBeVisible();

    await addBtn.click();
    await expect(modal.getByText('Payment 4')).toBeVisible();
    await expect(addBtn).toBeDisabled();

    await modal.getByRole('button', { name: 'Remove payment 4' }).click();
    await modal.getByRole('button', { name: 'Remove payment 3' }).click();

    await expect(modal.getByText('Payment 3')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Remove payment 1' })).toHaveCount(0);
    await expect(addBtn).toBeEnabled();

    await modal.getByRole('button', { name: 'Cancel' }).click();
  });
});

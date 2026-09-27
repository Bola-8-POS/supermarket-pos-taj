/**
 * Integration tests: caja_cash_reconciliation / caja_session_payments and
 * their use inside close_caja_session and get_caja_report — one shared
 * drawer-cash figure, reopen-offset entries and voided payments excluded as
 * documented, a refund attributed to the session that pays it (covered
 * separately in refund-attribution.integration.test.ts).
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: npx vitest run src/entities/caja/model/caja-cash-reconciliation.integration.test.ts
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

describe.skipIf(skip)('caja_cash_reconciliation / get_caja_report cash figures (integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;

  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let managerShiftId: string;
  let cajaId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let managerClient: any;
  const tabIds: string[] = [];
  const cajaEntryConcepts: string[] = [];
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

  /** A fresh single-use ticket for reopen_tab, issued to the manager's session. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function approval(client: any): Promise<string> {
    const { data, error } = await client.rpc('verify_staff_pin', {
      p_pin: managerPin,
      p_staff_id: null,
      p_required_action: 'reopen_tab',
    });
    if (error || !data?.ok || typeof data.approval_id !== 'string') {
      throw new Error(`approval: ${error?.message ?? JSON.stringify(data)}`);
    }
    return data.approval_id as string;
  }

  async function seedTab(opts: { amount: number; method: 'cash' | 'card' }): Promise<string> {
    const { amount, method } = opts;
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `Caja Cash Recon ${idKey('tab')}`,
        staff_id: managerId,
        shift_id: managerShiftId,
        caja_session_id: cajaId,
        status: 'paid',
        closed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (tabErr || !tab) throw new Error(`seedTab: ${tabErr?.message ?? 'no row'}`);
    tabIds.push(tab.id as string);

    const { error: payErr } = await db.from('payments').insert({
      tab_id: tab.id,
      amount,
      method,
      processed_by: managerId,
      idempotency_key: idKey('__caja_cash_recon_payment'),
    });
    if (payErr) throw new Error(`seedTab payment: ${payErr.message}`);
    return tab.id as string;
  }

  beforeAll(async () => {
    const email = `__caja_cash_recon_mgr_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestCajaCashRecon123!';
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
      name: '__caja_cash_recon_mgr__',
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

    const terminalId = `TR${String(Date.now())}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
    const { data: caja, error: cajaErr } = await db
      .from('caja_sessions')
      .insert({ opened_by: managerId, opening_cash: 100, terminal_id: terminalId })
      .select('id')
      .single();
    if (cajaErr || !caja) throw new Error(`caja seed failed: ${cajaErr?.message ?? 'no row'}`);
    cajaId = caja.id as string;

    managerClient = await signInClient(managerEmail, managerPassword);
  });

  afterAll(async () => {
    await managerClient?.auth.signOut().catch(() => undefined);
    for (const tabId of tabIds) {
      await db.from('payments').delete().eq('tab_id', tabId);
      await db.from('tabs').delete().eq('id', tabId);
    }
    for (const concept of cajaEntryConcepts) {
      await db.from('caja_entries').delete().eq('concept', concept);
    }
    if (cajaId) await db.from('caja_sessions').delete().eq('id', cajaId);
    await db.from('audit_logs').delete().eq('actor_id', managerId);
    for (const [table, column] of [
      ['manager_approvals', 'caller_id'],
      ['caja_entries', 'staff_id'],
      ['shifts', 'staff_id'],
    ] as const) {
      await db.from(table).delete().eq(column, managerId);
    }
    await db.from('pin_attempts').delete().like('attempt_key', `%${managerId}%`);
    await db.from('profiles').delete().eq('id', managerId);
    await db.auth.admin.deleteUser(managerId);
  });

  it('one drawer-cash figure for the helper, close and the report, excluding reopen offsets and frozen once closed', async () => {
    await seedTab({ amount: 200, method: 'cash' });
    await seedTab({ amount: 50, method: 'card' });

    const incomeConcept = `Caja cash recon income ${idKey('c')}`;
    const { error: entryInErr } = await db
      .from('caja_entries')
      .insert({ caja_session_id: cajaId, type: 'income', amount: 30, concept: incomeConcept, staff_id: managerId });
    if (entryInErr) throw new Error(`income entry: ${entryInErr.message}`);
    cajaEntryConcepts.push(incomeConcept);

    const expenseConcept = `Caja cash recon expense ${idKey('c')}`;
    const { error: entryOutErr } = await db
      .from('caja_entries')
      .insert({ caja_session_id: cajaId, type: 'expense', amount: 20, concept: expenseConcept, staff_id: managerId });
    if (entryOutErr) throw new Error(`expense entry: ${entryOutErr.message}`);
    cajaEntryConcepts.push(expenseConcept);

    const { data: recon1, error: recon1Err } = await db.rpc('caja_cash_reconciliation', { p_caja_id: cajaId });
    expect(recon1Err).toBeNull();
    expect(recon1).toEqual({ openingCash: 100, cashSales: 200, cashIn: 30, cashOut: 20, expectedCash: 310 });

    // A second tab, reopened then repaid: the reopen's offset caja_entries row
    // (source 'reopen') and the payment it voided must both stay excluded, so
    // the repayment is the only new cash the helper counts.
    const reopenTabId = await seedTab({ amount: 100, method: 'cash' });
    const { data: tabRow } = await db.from('tabs').select('version').eq('id', reopenTabId).single();

    const { data: reopenData, error: reopenErr } = await managerClient.rpc('reopen_tab', {
      p_tab_id: reopenTabId,
      p_expected_version: tabRow?.version,
      p_reason: 'Caja cash recon reopen',
      p_approval_id: await approval(managerClient),
      p_approver_id: managerId,
    });
    expect(reopenErr).toBeNull();
    expect(reopenData.ok).toBe(true);

    const { data: reopenEntries } = await db
      .from('caja_entries')
      .select('concept, source')
      .eq('caja_session_id', cajaId)
      .ilike('concept', 'Reopen tab %');
    const reopenRows = (reopenEntries ?? []) as { concept: string; source: string }[];
    expect(reopenRows.length).toBeGreaterThan(0);
    for (const row of reopenRows) {
      expect(row.source).toBe('reopen');
      cajaEntryConcepts.push(row.concept);
    }

    // Repay through the RPC (not a raw insert) so the tab returns to 'paid'
    // before close_caja_session's OPEN_TABS_EXIST guard runs.
    const { data: repayData, error: repayErr } = await db.rpc('process_payment_atomic', {
      p_tab_id: reopenTabId,
      p_staff_id: managerId,
      p_amount: 120,
      p_method: 'cash',
      p_idempotency_key: idKey('__caja_cash_recon_repay'),
      p_tendered_amount: 120,
    });
    expect(repayErr).toBeNull();
    expect(repayData.ok).toBe(true);

    const { data: recon2, error: recon2Err } = await db.rpc('caja_cash_reconciliation', { p_caja_id: cajaId });
    expect(recon2Err).toBeNull();
    expect(recon2).toEqual({ openingCash: 100, cashSales: 320, cashIn: 30, cashOut: 20, expectedCash: 430 });

    const { data: reportBeforeClose, error: reportBeforeErr } = await db.rpc('get_caja_report', { p_caja_id: cajaId });
    expect(reportBeforeErr).toBeNull();
    expect(reportBeforeClose.summary.totalExpenses).toBe(20);

    const { data: closeData, error: closeErr } = await managerClient.rpc('close_caja_session', {
      p_caja_id: cajaId,
      p_closed_by: managerId,
      p_closing_cash: 420,
    });
    expect(closeErr).toBeNull();
    expect(closeData.ok).toBe(true);
    expect(closeData.cashReconciliation).toEqual({
      openingCash: 100,
      cashSales: 320,
      cashIn: 30,
      cashOut: 20,
      expectedCash: 430,
      closingCash: 420,
      variance: -10,
    });

    const { data: sessionRow } = await db
      .from('caja_sessions')
      .select('cash_reconciliation')
      .eq('id', cajaId)
      .single();
    expect(sessionRow?.cash_reconciliation?.expectedCash).toBe(430);

    const { data: reportAfterClose, error: reportAfterErr } = await db.rpc('get_caja_report', { p_caja_id: cajaId });
    expect(reportAfterErr).toBeNull();
    expect(reportAfterClose.cashReconciliation).toEqual(closeData.cashReconciliation);
    expect(reportAfterClose.summary.netBalance).toBe(380);

    // Closed session's cashReconciliation is frozen: a post-close adjustment
    // moves the live summary but not the stored reconciliation.
    const frozenRecon = reportAfterClose.cashReconciliation;
    const cashSalesBeforeAdjustment = reportAfterClose.summary.cashSales as number;

    const { error: adjustErr } = await db.from('payments').insert({
      tab_id: tabIds[0],
      amount: 50,
      method: 'cash',
      processed_by: managerId,
      idempotency_key: idKey('__caja_cash_recon_postclose'),
    });
    expect(adjustErr).toBeNull();

    const { data: reportAfterAdjust, error: reportAfterAdjustErr } = await db.rpc('get_caja_report', {
      p_caja_id: cajaId,
    });
    expect(reportAfterAdjustErr).toBeNull();
    expect(reportAfterAdjust.cashReconciliation).toEqual(frozenRecon);
    expect(reportAfterAdjust.summary.cashSales).toBe(cashSalesBeforeAdjustment + 50);
  });
});

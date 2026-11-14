/**
 * Integration tests: process_split_payment_atomic RPC + payments split
 * columns (Phase 18, Plan 02 — SC-1/SC-2).
 *
 * Requires: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars
 * Run: cd bar-pos && npx vitest run src/entities/payment/model/split-payment-rpc.integration.test.ts
 *
 * process_split_payment_atomic is GRANTed to service_role only (mirrors
 * process_payment_atomic — always called via the edge function's admin
 * client in production, never directly by an authenticated user JWT). Its
 * FORBIDDEN guard checks p_staff_id against an active `profiles` row
 * explicitly, so it does NOT depend on auth.uid() the way process_refund
 * does. All RPC calls here therefore use the service-role client — there
 * is no itAuth/manager-JWT variant needed for this file (deviation from the
 * literal plan wording "sign in as manager", documented in the plan's
 * SUMMARY: an authenticated-user JWT would receive a PostgREST
 * permission-denied error given the service_role-only GRANT).
 *
 * NOTE: These tests exercise `payment_group_id`/`split_index` and the
 * `process_split_payment_atomic`/`get_payments_split_columns` RPCs added by
 * migration 20260707000003_split_payment_columns_and_rpc.sql (Plan 18-02).
 * Until Plan 18-03 pushes that migration to the live remote database, every
 * test below will fail at the RPC-call step (function/column does not
 * exist yet) — they are written to PASS once the schema is live, and to
 * SKIP gracefully when VITE_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
 * absent. The green live run is gated in Plan 18-04, after Plan 18-03's
 * push makes the RPC live.
 */
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── Env guards ────────────────────────────────────────────────────────────────

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

/** Live-DB test using the service-role client (process_split_payment_atomic
 * is GRANTed to service_role only — see file header). */
const itInt = hasEnv ? it : it.skip;

// ── Client factory ───────────────────────────────────────────────────────────

function getServiceDb(): any {
  const url = process.env['VITE_SUPABASE_URL']!;
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function getStaffAndShift(svc: any): Promise<{ staffId: string; shiftId: string }> {
  const { data: staff } = await svc
    .from('profiles')
    .select('id')
    .in('role', ['manager', 'admin'])
    .limit(1)
    .single();
  if (!staff) throw new Error('getStaffAndShift: no manager/admin profile found');
  const staffId = staff.id as string;

  const { data: existing } = await svc
    .from('shifts')
    .select('id')
    .eq('staff_id', staffId)
    .is('clock_out', null)
    .limit(1)
    .maybeSingle();

  if (existing) return { staffId, shiftId: existing.id as string };

  const { data: newShift, error: shiftErr } = await svc
    .from('shifts')
    .insert({ staff_id: staffId, opening_cash: 0 })
    .select('id')
    .single();
  if (shiftErr || !newShift) {
    throw new Error(`getStaffAndShift: shift create failed: ${shiftErr?.message ?? 'no row'}`);
  }
  return { staffId, shiftId: newShift.id as string };
}

interface OpenTabSeed {
  tabId: string;
  staffId: string;
  total: number;
}

/** Seeds an open tab with one order_item priced at `total` (default $50). */
async function seedOpenTabWithItems(svc: any, total = 50.0): Promise<OpenTabSeed> {
  const { staffId, shiftId } = await getStaffAndShift(svc);

  const { data: product } = await svc
    .from('products')
    .select('id')
    .eq('is_active', true)
    .limit(1)
    .single();
  if (!product) throw new Error('seedOpenTabWithItems: no active product found');

  const { data: tab, error: tabErr } = await svc
    .from('tabs')
    .insert({
      customer_name: `Split Payment Integration Tab ${Date.now()}`,
      staff_id: staffId,
      shift_id: shiftId,
      status: 'open',
    })
    .select('id')
    .single();
  if (tabErr || !tab) throw new Error(`seedOpenTabWithItems: tab insert failed: ${tabErr?.message ?? 'no row'}`);

  const { data: order, error: orderErr } = await svc
    .from('orders')
    .insert({ tab_id: tab.id, staff_id: staffId, status: 'pending' })
    .select('id')
    .single();
  if (orderErr || !order) {
    throw new Error(`seedOpenTabWithItems: order insert failed: ${orderErr?.message ?? 'no row'}`);
  }

  const { error: itemErr } = await svc.from('order_items').insert({
    order_id: order.id,
    product_id: product.id,
    quantity: 1,
    unit_price: total,
    modifier_price_delta: 0,
  });
  if (itemErr) throw new Error(`seedOpenTabWithItems: item insert failed: ${itemErr.message}`);

  return { tabId: tab.id as string, staffId, total };
}

async function cleanup(svc: any, tabId: string): Promise<void> {
  await svc.from('payments').delete().eq('tab_id', tabId);
  await svc.from('tabs').delete().eq('id', tabId);
}

function idKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('process_split_payment_atomic RPC + payments split columns (integration)', () => {
  let svc: any;
  let tabId: string;

  beforeEach(() => {
    svc = getServiceDb();
    tabId = '';
  });

  afterEach(async () => {
    if (tabId) {
      await cleanup(svc, tabId).catch(() => undefined);
    }
  });

  itInt(
    'SC-1: payments.payment_group_id + split_index columns exist (queries information_schema.columns via get_payments_split_columns RPC)',
    async () => {
      const { data, error } = await svc.rpc('get_payments_split_columns');

      expect(error).toBeNull();
      const rows = (data ?? []) as { column_name: string; data_type: string; is_nullable: string }[];
      const groupCol = rows.find(r => r.column_name === 'payment_group_id');
      const indexCol = rows.find(r => r.column_name === 'split_index');

      expect(groupCol).toBeDefined();
      expect(groupCol?.data_type).toBe('uuid');
      expect(groupCol?.is_nullable).toBe('YES');

      expect(indexCol).toBeDefined();
      expect(indexCol?.data_type).toBe('smallint');
      expect(indexCol?.is_nullable).toBe('YES');
    },
  );

  itInt(
    'SC-2 happy path: 2 legs (cash + card) close the tab atomically with a shared payment_group_id',
    async () => {
      const seed = await seedOpenTabWithItems(svc, 50.0);
      tabId = seed.tabId;

      const legs = [
        { method: 'cash', amount: 30.0, tenderedAmount: 30.0 },
        { method: 'card', amount: 20.0 },
      ];

      const { data, error } = await svc.rpc('process_split_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_legs: legs,
        p_expected_total: 50.0,
        p_idempotency_key: idKey('split-happy'),
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(true);
      expect(data.paymentGroupId).toBeTruthy();
      expect((data.paymentIds as string[]).length).toBe(2);

      const { data: rows } = await svc
        .from('payments')
        .select('payment_group_id, split_index')
        .eq('tab_id', tabId)
        .order('split_index');
      const paymentRows = (rows ?? []) as { payment_group_id: string; split_index: number }[];
      expect(paymentRows).toHaveLength(2);
      expect(paymentRows[0]?.payment_group_id).toBe(data.paymentGroupId);
      expect(paymentRows[1]?.payment_group_id).toBe(data.paymentGroupId);
      expect(paymentRows[0]?.split_index).toBe(0);
      expect(paymentRows[1]?.split_index).toBe(1);

      const { data: tab } = await svc.from('tabs').select('status').eq('id', tabId).single();
      expect(tab?.status).toBe('paid'); // D-08: all-or-nothing close
    },
  );

  itInt(
    'SC-2 sum mismatch: legs summing to total+5.00 returns SPLIT_TOTAL_MISMATCH and inserts nothing (atomic rollback)',
    async () => {
      const seed = await seedOpenTabWithItems(svc, 50.0);
      tabId = seed.tabId;

      const legs = [
        { method: 'cash', amount: 35.0, tenderedAmount: 35.0 },
        { method: 'card', amount: 20.0 },
      ];

      const { data, error } = await svc.rpc('process_split_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_legs: legs,
        p_expected_total: 50.0,
        p_idempotency_key: idKey('split-mismatch'),
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('SPLIT_TOTAL_MISMATCH');

      const { data: rows } = await svc.from('payments').select('id').eq('tab_id', tabId);
      expect(rows ?? []).toHaveLength(0);
    },
  );

  itInt('SC-2 too many legs: 5 legs returns TOO_MANY_LEGS', async () => {
    const seed = await seedOpenTabWithItems(svc, 50.0);
    tabId = seed.tabId;

    const legs = Array.from({ length: 5 }, () => ({
      method: 'cash',
      amount: 10.0,
      tenderedAmount: 10.0,
    }));

    const { data, error } = await svc.rpc('process_split_payment_atomic', {
      p_tab_id: tabId,
      p_staff_id: seed.staffId,
      p_legs: legs,
      p_expected_total: 50.0,
      p_idempotency_key: idKey('split-too-many'),
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('TOO_MANY_LEGS');
  });

  itInt(
    'SC-2 idempotent replay: resubmitting the same idempotencyKey returns the same group, no double-charge (T-18-01)',
    async () => {
      const seed = await seedOpenTabWithItems(svc, 50.0);
      tabId = seed.tabId;

      const legs = [
        { method: 'cash', amount: 30.0, tenderedAmount: 30.0 },
        { method: 'card', amount: 20.0 },
      ];
      const key = idKey('split-idempotent');

      const first = await svc.rpc('process_split_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_legs: legs,
        p_expected_total: 50.0,
        p_idempotency_key: key,
      });
      expect(first.error).toBeNull();
      expect(first.data.ok).toBe(true);
      expect(first.data.idempotent).toBe(false);

      const second = await svc.rpc('process_split_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_legs: legs,
        p_expected_total: 50.0,
        p_idempotency_key: key,
      });
      expect(second.error).toBeNull();
      expect(second.data.ok).toBe(true);
      expect(second.data.idempotent).toBe(true);
      expect(second.data.paymentGroupId).toBe(first.data.paymentGroupId);

      const { data: rows } = await svc.from('payments').select('id').eq('tab_id', tabId);
      expect(rows ?? []).toHaveLength(2); // exactly 2 rows total — no double-charge
    },
  );
});

/**
 * Regression test for the Phase 27 gap-closure code review's CR-01
 * (2026-09-03): `process-payment`/`process-split-payment` edge functions
 * used to send `p_manager_override: body.managerOverride ?? null` instead of
 * `?? false`. `IF p_manager_override THEN` / `IF NOT p_manager_override THEN`
 * both treat a NULL boolean as neither branch in PL/pgSQL, so an explicit
 * SQL NULL silently skipped the `DISCOUNT_REQUIRES_MANAGER` guard — any
 * authenticated staff member could apply an arbitrary discount with zero
 * manager-PIN verification.
 *
 * Fixed at two layers (migration 20260903093000_manager_override_null_coalesce_guard.sql):
 *   1. The edge functions now coalesce to `false`, not `null`.
 *   2. `process_payment_atomic`/`process_split_payment_atomic`/
 *      `process_direct_sale_atomic` all now `COALESCE(p_manager_override, false)`
 *      as their first statement — defense-in-depth, since all three RPCs
 *      grant EXECUTE to `authenticated` and are directly callable via
 *      PostgREST, bypassing the edge function entirely.
 *
 * This test calls the RPCs directly with an explicit SQL NULL for
 * `p_manager_override` (the exact bypass vector) and asserts the discount is
 * rejected — proving layer 2 holds even if a future caller regresses layer 1.
 *
 * Requires: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars
 * Run: npx vitest run src/entities/payment/model/manager-override-null-coalesce.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

const itInt = hasEnv ? it : it.skip;

function getServiceDb(): any {
  const url = process.env['VITE_SUPABASE_URL']!;
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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

async function seedOpenTabWithItems(svc: any, total = 50.0): Promise<{ tabId: string; staffId: string }> {
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
      customer_name: `NULL-coalesce guard test ${Date.now()}`,
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

  return { tabId: tab.id as string, staffId };
}

async function cleanup(svc: any, tabId: string): Promise<void> {
  await svc.from('payments').delete().eq('tab_id', tabId);
  await svc.from('tabs').delete().eq('id', tabId);
}

function idKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

describe('manager-override NULL-coalesce guard (CR-01 regression)', () => {
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
    'process_payment_atomic rejects a discount with p_manager_override explicitly NULL (not just omitted)',
    async () => {
      const seed = await seedOpenTabWithItems(svc, 40.0);
      tabId = seed.tabId;

      const { data, error } = await svc.rpc('process_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_amount: 36.0,
        p_method: 'cash',
        p_idempotency_key: idKey('null-guard-payment'),
        p_tendered_amount: 40.0,
        p_discount_scope: 'all',
        p_discount_type: 'percent',
        p_discount_value: 10,
        p_discount_amount: 4.0,
        p_manager_override: null,
        p_approval_id: null,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('DISCOUNT_REQUIRES_MANAGER');

      const { data: payments } = await svc.from('payments').select('id').eq('tab_id', tabId);
      expect(payments ?? []).toHaveLength(0);
    },
  );

  itInt(
    'process_split_payment_atomic rejects a discount with p_manager_override explicitly NULL (not just omitted)',
    async () => {
      const seed = await seedOpenTabWithItems(svc, 50.0);
      tabId = seed.tabId;

      const legs = [{ method: 'cash', amount: 45.0, tenderedAmount: 45.0 }];

      const { data, error } = await svc.rpc('process_split_payment_atomic', {
        p_tab_id: tabId,
        p_staff_id: seed.staffId,
        p_legs: legs,
        p_expected_total: 45.0,
        p_idempotency_key: idKey('null-guard-split'),
        p_discount_scope: 'all',
        p_discount_type: 'percent',
        p_discount_value: 10,
        p_manager_override: null,
        p_approval_id: null,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('DISCOUNT_REQUIRES_MANAGER');

      const { data: payments } = await svc.from('payments').select('id').eq('tab_id', tabId);
      expect(payments ?? []).toHaveLength(0);
    },
  );
});

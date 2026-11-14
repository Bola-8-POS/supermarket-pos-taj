/* eslint-disable */
/**
 * Shared dev2 fixtures for the assistant write-contract integration tests (migration 20261108000002).
 * Test-only: imported by *.integration.test.ts files, never by app code.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (dev2, 127.0.0.1:56321) and
 * the dev2 edge runtime (staff-sign-in). `skip` is true without them, and a skip is NOT VERIFIED (L48).
 *
 * Staff are created with the derived-password recipe (L49), sign in through the real staff-sign-in function, and are
 * removed in cleanup(). Every proposal row of the created staff is deleted first (FK), audit rows keep a NULL actor.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { deriveStaffPassword } from '../../scripts/lib/staff-password';
import { unusedPin } from './pin-helpers';

export const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
export const skip = !url || !serviceKey || !anonKey;

export type Role = 'cashier' | 'manager' | 'admin';
export type TestStaff = { id: string; role: Role; pin: string; email: string; client: any };

export const TERMINAL = 'ASSIST-IT';
export const MODEL = 'it-model@it-runtime';

export function createAssistantFixtures(tag: string) {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const staff: TestStaff[] = [];
  const productIds: string[] = [];
  let categoryId = '';
  let grantedCashierAdjust = false;

  async function newStaff(role: Role, label: string = role): Promise<TestStaff> {
    const id = randomUUID();
    const pin = await unusedPin(db);
    const email = `${tag}${label}_${stamp}_${staff.length}@test.local`;
    const created = await db.auth.admin.createUser({
      id,
      email,
      password: await deriveStaffPassword(id, pin),
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw new Error(`create ${role}: ${created.error?.message}`);
    const prof = await db
      .from('profiles')
      .upsert({ id, name: `${tag}${label}`, email, role, pin, is_active: true });
    if (prof.error) throw new Error(`profile: ${prof.error.message}`);
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey! },
      body: JSON.stringify({ staffId: id, pin }),
    });
    const json: any = await res.json().catch(() => null);
    if (res.status !== 200) throw new Error(`sign in: ${res.status} ${JSON.stringify(json)}`);
    const client = anon();
    const set = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (set.error) throw new Error(`setSession: ${set.error.message}`);
    const member: TestStaff = { id, role, pin, email, client };
    staff.push(member);
    return member;
  }

  async function addProduct(label: string, qty: number): Promise<string> {
    if (!categoryId) {
      const cat = await db.from('categories').select('id').limit(1).single();
      if (cat.error || !cat.data) throw new Error(`no category: ${cat.error?.message}`);
      categoryId = cat.data.id as string;
    }
    const { data, error } = await db
      .from('products')
      .insert({
        name: `${tag}${label} ${stamp}`,
        category_id: categoryId,
        base_price: 12.5,
        is_active: true,
        sold_by_weight: false,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture product ${label}: ${error?.message}`);
    productIds.push(data.id as string);
    const inv = await db.from('inventory').insert({ product_id: data.id, quantity_on_hand: qty });
    if (inv.error) throw new Error(`fixture inventory ${label}: ${inv.error.message}`);
    return data.id as string;
  }

  /** The default matrix gives cashiers no adjust_inventory; a cashier requester needs it edited (restored in cleanup). */
  async function grantCashierAdjust(): Promise<void> {
    const existing = await db.from('role_permissions').select('role').eq('role', 'cashier').eq('action', 'adjust_inventory');
    if (existing.error) throw new Error(`matrix read: ${existing.error.message}`);
    if (existing.data.length > 0) return;
    const ins = await db.from('role_permissions').insert({ role: 'cashier', action: 'adjust_inventory' });
    if (ins.error) throw new Error(`matrix grant: ${ins.error.message}`);
    grantedCashierAdjust = true;
  }

  const qty = async (productId: string): Promise<number> => {
    const { data, error } = await db.from('inventory').select('quantity_on_hand').eq('product_id', productId).single();
    if (error) throw new Error(`qty: ${error.message}`);
    return data.quantity_on_hand as number;
  };

  /** Raw RPC data (the coded `{ ok, code }` object), throwing on a transport error. */
  async function rpc(client: any, fn: string, args?: Record<string, unknown>): Promise<any> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  }

  const adjustItem = (productId: string, delta: number, expected: number) => ({
    product_id: productId,
    delta,
    expected_quantity: expected,
  });

  const stage = (requester: TestStaff, items: unknown, over: Record<string, unknown> = {}) =>
    rpc(requester.client, 'assistant_stage', {
      p_kind: 'inventory.adjust',
      p_items: items,
      p_reason: 'waste',
      p_terminal_id: TERMINAL,
      p_model: MODEL,
      p_policy_version: 'it-policy',
      p_prompt_version: 'it-prompt',
      p_raw_text: 'write off expired items',
      ...over,
    });

  /** A single-use approval ticket issued to `requester` for `action` after `approverPin` was entered. */
  async function ticket(requester: TestStaff, approverPin: string, action = 'adjust_inventory') {
    const res = await rpc(requester.client, 'verify_staff_pin', {
      p_pin: approverPin,
      p_staff_id: null,
      p_required_action: action,
    });
    if (!res?.ok || !res.approval_id) throw new Error(`ticket: ${JSON.stringify(res)}`);
    return { approvalId: res.approval_id as string, approverId: res.matches[0].id as string };
  }

  const approve = (
    requester: TestStaff,
    staged: { proposal_id: string; payload_hash: string },
    approverId: string,
    approvalId: string,
    over: Record<string, unknown> = {}
  ) =>
    rpc(requester.client, 'assistant_approve', {
      p_proposal_id: staged.proposal_id,
      p_payload_hash: staged.payload_hash,
      p_approval_id: approvalId,
      p_approver_id: approverId,
      p_terminal_id: TERMINAL,
      ...over,
    });

  /** Stage one item and approve it with `approver`'s PIN; returns both raw results. */
  async function stageAndApprove(requester: TestStaff, approver: TestStaff, items: unknown) {
    const staged = await stage(requester, items);
    if (!staged.ok) return { staged, approved: null };
    const t = await ticket(requester, approver.pin);
    return { staged, approved: await approve(requester, staged, t.approverId, t.approvalId) };
  }

  /** Test isolation: forget the actor's refusals so one test's denials never lock the next (service role). */
  async function resetCooldown(member: TestStaff): Promise<void> {
    const del = await db.from('audit_logs').delete().eq('actor_id', member.id).like('action', 'assistant.%');
    if (del.error) throw new Error(`resetCooldown: ${del.error.message}`);
  }

  async function auditRows(actorId: string, entityId?: string): Promise<any[]> {
    let q = db.from('audit_logs').select('action, entity_id, source, after, terminal_id, actor_id').eq('actor_id', actorId).like('action', 'assistant.%');
    if (entityId) q = q.eq('entity_id', entityId);
    const { data, error } = await q.order('created_at');
    if (error) throw new Error(`auditRows: ${error.message}`);
    return data;
  }

  async function cleanup(): Promise<void> {
    // Surface every failed delete: a leftover profile on dev2 is debris the next run trips over.
    const failures: string[] = [];
    const run = async (label: string, op: PromiseLike<{ error: { message: string } | null }>) => {
      const res = await op;
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    const ids = staff.map(s => s.id);
    if (ids.length) {
      await run('proposals(requester)', db.from('assistant_proposals').delete().in('requester_id', ids));
      await run('proposals(approver)', db.from('assistant_proposals').delete().in('approver_id', ids));
      // adjust_inventory's idempotency ledger and its stock movements both reference the acting staff.
      await run('rpc_idempotency', db.from('rpc_idempotency').delete().in('staff_id', ids));
      await run('stock_movements(staff)', db.from('stock_movements').delete().in('staff_id', ids));
    }
    if (productIds.length) {
      await run('stock_movements', db.from('stock_movements').delete().in('product_id', productIds));
      await run('inventory', db.from('inventory').delete().in('product_id', productIds));
      await run('products', db.from('products').delete().in('id', productIds));
    }
    if (grantedCashierAdjust) {
      await run('matrix', db.from('role_permissions').delete().eq('role', 'cashier').eq('action', 'adjust_inventory'));
    }
    for (const s of staff) {
      await run('pin_attempts', db.from('pin_attempts').delete().like('attempt_key', `%${s.id}%`));
      await run('manager_approvals', db.from('manager_approvals').delete().eq('caller_id', s.id));
      await run('profile', db.from('profiles').delete().eq('id', s.id));
      const del = await db.auth.admin.deleteUser(s.id);
      if (del.error) failures.push(`auth user: ${del.error.message}`);
    }
    if (failures.length) throw new Error(`assistant fixtures cleanup left debris on dev2: ${failures.join('; ')}`);
  }

  return {
    db,
    anon,
    newStaff,
    addProduct,
    grantCashierAdjust,
    qty,
    rpc,
    adjustItem,
    stage,
    ticket,
    approve,
    stageAndApprove,
    resetCooldown,
    auditRows,
    cleanup,
  };
}

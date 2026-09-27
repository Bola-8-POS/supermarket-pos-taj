import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { STAFF_ACTIONS } from '@shared/lib/rbac';

/**
 * Integration test: every action the client's RBAC module declares has at
 * least one role_permissions row. verify_staff_pin's p_required_action rule
 * treats role_permissions as the sole source of truth for eligibility, so an
 * action missing here makes every PIN gate that checks it unpassable for
 * every role, no matter what the client-side RBAC table says.
 *
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (local stack).
 * Skips gracefully when they are absent.
 *
 * Run: npx vitest run src/entities/staff/model/role-permissions-coverage.integration.test.ts --project integration
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey;

describe.skipIf(skip)('role_permissions coverage', () => {
  it('every client-side action has at least one role permission row', async () => {
    const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
    const { data, error } = await db.from('role_permissions').select('action');
    expect(error).toBeNull();

    const covered = new Set((data as Array<{ action: string }>).map(row => row.action));
    const missing = STAFF_ACTIONS.filter(action => !covered.has(action));

    expect(missing).toEqual([]);
  });
});

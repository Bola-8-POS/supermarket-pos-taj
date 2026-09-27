/**
 * seed-reports.ts
 *
 * Seeds E2E test data for analytics reports:
 *   - 7 days of combo sales (order_items referencing a combo product)
 *   - 3 refunds (referencing existing payments)
 *   - 5 waitlist entries (status = 'seated', seated_at = 30 min after created_at)
 *
 * Idempotent — safe to re-run (uses ON CONFLICT DO NOTHING or insert-only patterns).
 * Prints "seed-reports: done" on success.
 *
 * Usage: cd bar-pos && npx tsx scripts/seed-reports.ts
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * WARNING: Uses service role key — do NOT import this in the renderer.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local from bar-pos/ directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // fallback to .env
}

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'seed-reports: missing VITE_SUPABASE_URL (or SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local'
  );
  process.exit(1);
}

// Service role client — bypasses RLS for seeding
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

async function seedReports(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Combo sales — 7 order_items referencing a combo product
  // ---------------------------------------------------------------------------
  const { data: combos } = await db
    .from('products')
    .select('id, base_price')
    .eq('is_combo', true)
    .eq('is_active', true)
    .limit(1);

  const comboProduct = combos?.[0] as { id: string; base_price: number } | undefined;

  if (comboProduct) {
    // Find or create an open tab to attach the order_items to
    const { data: openTabs } = await db
      .from('tabs')
      .select('id')
      .eq('status', 'open')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1);

    let tabId: string | null = (openTabs?.[0] as { id: string } | undefined)?.id ?? null;

    if (!tabId) {
      // Create a seed tab if no open tab exists
      const { data: staff } = await db.from('profiles').select('id').limit(1).maybeSingle();
      const { data: shift } = await db
        .from('shifts')
        .select('id')
        .eq('staff_id', staff?.id)
        .is('clock_out', null)
        .limit(1)
        .maybeSingle();

      if (staff?.id) {
        const { data: newTab } = await db
          .from('tabs')
          .insert({
            customer_name: 'Seed Reports Tab',
            staff_id: staff.id,
            shift_id: shift?.id ?? null,
            status: 'open',
            is_deleted: false,
          })
          .select('id')
          .single();
        tabId = (newTab as { id: string } | null)?.id ?? null;
      }
    }

    if (tabId) {
      // Find a staff member for orders
      const { data: staff } = await db.from('profiles').select('id').limit(1).maybeSingle();

      if (staff?.id) {
        let insertedCount = 0;
        const now = new Date();

        for (let i = 0; i < 7; i++) {
          // Create one order per day for the past 7 days
          const createdAt = new Date(now.getTime() - i * 24 * 3600 * 1000).toISOString();

          const { data: order } = await db
            .from('orders')
            .insert({
              tab_id: tabId,
              staff_id: staff.id,
              status: 'pending',
              created_at: createdAt,
            })
            .select('id')
            .maybeSingle();

          if (order?.id) {
            await db.from('order_items').insert({
              order_id: order.id,
              product_id: comboProduct.id,
              quantity: 1,
              unit_price: comboProduct.base_price,
              modifier_price_delta: 0,
              created_at: createdAt,
            });
            insertedCount++;
          }
        }

        console.log(`seed-reports: inserted ${String(insertedCount)} combo order_items`);
      }
    } else {
      console.log('seed-reports: no tab available for combo order_items — skipped');
    }
  } else {
    console.log('seed-reports: no combo product found — skipped combo order_items');
  }

  // ---------------------------------------------------------------------------
  // 2. Refunds — 3 rows referencing existing payments
  // ---------------------------------------------------------------------------
  const { data: payments } = await db
    .from('payments')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(3);

  const { data: adminProfile } = await db
    .from('profiles')
    .select('id')
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();

  const adminId = (adminProfile as { id: string } | null)?.id;

  if (payments && (payments as { id: string }[]).length > 0 && adminId) {
    let refundCount = 0;
    for (const p of payments as { id: string }[]) {
      const { error } = await db.from('refunds').insert({
        original_payment_id: p.id,
        amount: 50,
        reason: 'customer_request',
        created_by: adminId,
      });
      if (!error) refundCount++;
    }
    console.log(`seed-reports: inserted ${String(refundCount)} refunds`);
  } else {
    console.log('seed-reports: no payments found or no admin profile — skipped refunds');
  }

  // ---------------------------------------------------------------------------
  // 3. Waitlist entries — 5 seated entries
  // ---------------------------------------------------------------------------
  const now = new Date();
  const waitlistEntries = Array.from({ length: 5 }, (_, i) => {
    const createdAt = new Date(now.getTime() - (i + 1) * 3600 * 1000);
    const seatedAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
    return {
      party_name: `Seed Party ${String(i + 1)}`,
      party_size: 2 + i,
      status: 'seated',
      created_at: createdAt.toISOString(),
      seated_at: seatedAt.toISOString(),
    };
  });

  const { error: wErr } = await db.from('waitlist_entries').insert(waitlistEntries);
  if (!wErr) {
    console.log('seed-reports: inserted 5 waitlist entries');
  } else {
    console.log('seed-reports: waitlist_entries insert failed —', wErr.message);
  }

  console.log('seed-reports: done');
}

void seedReports().catch(e => {
  console.error('seed-reports: fatal error —', e);
  process.exit(1);
});

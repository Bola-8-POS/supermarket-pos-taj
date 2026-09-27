/**
 * seed-combos.ts
 *
 * Seeds demo combo products: Cubeta Regular, Cubeta Premium, Martes de Cubeta + Pool.
 * Idempotent — safe to re-run (uses select-then-upsert / delete-then-insert patterns).
 *
 * Usage: cd bar-pos && npx tsx scripts/seed-combos.ts
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * WARNING: Uses service role key — do NOT import this in the renderer.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load .env.local from bar-pos/ directory
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
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local'
  );
  process.exit(1);
}

// Service role client — bypasses RLS for seeding
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Upsert a product by name (select first, then insert if missing). Returns the product id. */
async function upsertProduct(data: {
  name: string;
  category_id: string;
  base_price: number;
  is_active: boolean;
  is_combo: boolean;
  combo_eligible: boolean;
  combo_price_override: number | null;
}): Promise<string> {
  const { data: existing } = await db
    .from('products')
    .select('id')
    .eq('name', data.name)
    .maybeSingle();

  if (existing) {
    // Update in-place so re-runs pick up price changes
    await db.from('products').update(data).eq('id', existing.id);
    return existing.id as string;
  }

  const { data: inserted, error } = await db.from('products').insert(data).select('id').single();
  if (error) {
    console.error(`Failed to insert product "${data.name}":`, error);
    process.exit(1);
  }
  return (inserted as { id: string }).id;
}

/**
 * Upsert a combo slot by (combo_product_id, label).
 * combo_slots has no unique constraint on (combo_product_id, label), so we do select-then-insert.
 */
async function upsertComboSlot(data: {
  combo_product_id: string;
  label: string;
  slot_type: string;
  min_qty: number;
  max_qty: number;
  is_required: boolean;
  sort_order: number;
}): Promise<string> {
  const { data: existing } = await db
    .from('combo_slots')
    .select('id')
    .eq('combo_product_id', data.combo_product_id)
    .eq('label', data.label)
    .maybeSingle();

  if (existing) {
    await db.from('combo_slots').update(data).eq('id', existing.id);
    return existing.id as string;
  }

  const { data: inserted, error } = await db
    .from('combo_slots')
    .insert(data)
    .select('id')
    .single();
  if (error) {
    console.error(`Failed to insert combo_slot "${data.label}":`, error);
    process.exit(1);
  }
  return (inserted as { id: string }).id;
}

/** Upsert a combo_slot_option by (combo_slot_id, child_product_id). */
async function upsertSlotOption(data: {
  combo_slot_id: string;
  child_product_id: string | null;
  prepaid_minutes: number | null;
  sort_order: number;
}): Promise<void> {
  const query =
    data.child_product_id != null
      ? db
          .from('combo_slot_options')
          .select('id')
          .eq('combo_slot_id', data.combo_slot_id)
          .eq('child_product_id', data.child_product_id)
          .maybeSingle()
      : db
          .from('combo_slot_options')
          .select('id')
          .eq('combo_slot_id', data.combo_slot_id)
          .is('child_product_id', null)
          .maybeSingle();

  const { data: existing } = await query;

  if (existing) {
    await db.from('combo_slot_options').update(data).eq('id', existing.id);
    return;
  }

  const { error } = await db.from('combo_slot_options').insert(data);
  if (error) {
    console.error(`Failed to insert combo_slot_option:`, error);
    // Non-fatal — log and continue
  }
}

/** Populate slot options from products in a given category with combo_eligible=true. */
async function populateOptionsFromCategory(
  slotId: string,
  categoryId: string | null
): Promise<void> {
  if (!categoryId) return;

  const { data: beers } = await db
    .from('products')
    .select('id')
    .eq('category_id', categoryId)
    .eq('combo_eligible', true)
    .eq('is_active', true);

  for (const beer of (beers as { id: string }[] | null) ?? []) {
    await upsertSlotOption({
      combo_slot_id: slotId,
      child_product_id: beer.id,
      prepaid_minutes: null,
      sort_order: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Seeding combo products...');

  // 1. Ensure a "Combos" category exists
  const { data: existingComboCat } = await db
    .from('categories')
    .select('id')
    .eq('name', 'Combos')
    .maybeSingle();

  let comboCategoryId: string;
  if (existingComboCat) {
    comboCategoryId = (existingComboCat as { id: string }).id;
  } else {
    const { data: newCat, error: catErr } = await db
      .from('categories')
      .insert({ name: 'Combos', color: '#6366f1', sort_order: 99, is_food: false })
      .select('id')
      .single();
    if (catErr) {
      console.error('Category insert failed:', catErr);
      process.exit(1);
    }
    comboCategoryId = (newCat as { id: string }).id;
  }

  // 2. Find "Regular" and "Premium" beer categories (may not exist in all environments)
  const { data: regularCat } = await db
    .from('categories')
    .select('id')
    .eq('name', 'Regular')
    .maybeSingle();
  const { data: premiumCat } = await db
    .from('categories')
    .select('id')
    .eq('name', 'Premium')
    .maybeSingle();
  const regularCategoryId: string | null = (regularCat as { id: string } | null)?.id ?? null;
  const premiumCategoryId: string | null = (premiumCat as { id: string } | null)?.id ?? null;

  // 3. Cubeta Regular — is_combo=true, combo_price_override=350
  //    1 slot: "Beers" (product, min=10, max=10, required)
  const cubetaRegularId = await upsertProduct({
    name: 'Cubeta Regular',
    category_id: comboCategoryId,
    base_price: 350,
    is_active: true,
    is_combo: true,
    combo_eligible: false,
    combo_price_override: 350,
  });

  const cubetaRegularBeersSlotId = await upsertComboSlot({
    combo_product_id: cubetaRegularId,
    label: 'Beers',
    slot_type: 'product',
    min_qty: 10,
    max_qty: 10,
    is_required: true,
    sort_order: 0,
  });

  await populateOptionsFromCategory(cubetaRegularBeersSlotId, regularCategoryId);

  // 4. Cubeta Premium — is_combo=true, combo_price_override=450
  //    1 slot: "Beers" (product, min=10, max=10, required)
  const cubetaPremiumId = await upsertProduct({
    name: 'Cubeta Premium',
    category_id: comboCategoryId,
    base_price: 450,
    is_active: true,
    is_combo: true,
    combo_eligible: false,
    combo_price_override: 450,
  });

  const cubetaPremiumBeersSlotId = await upsertComboSlot({
    combo_product_id: cubetaPremiumId,
    label: 'Beers',
    slot_type: 'product',
    min_qty: 10,
    max_qty: 10,
    is_required: true,
    sort_order: 0,
  });

  await populateOptionsFromCategory(cubetaPremiumBeersSlotId, premiumCategoryId);

  // 5. Martes de Cubeta + Pool — is_combo=true, combo_price_override=400
  //    slot 1: "Beers" (product, min=6, max=6, required)
  //    slot 2: "Pool Time" (pool_time, prepaid_minutes=60, required)
  //    availability: daysOfWeek=[2] (Tuesday only)
  const martesCubetaId = await upsertProduct({
    name: 'Martes de Cubeta + Pool',
    category_id: comboCategoryId,
    base_price: 400,
    is_active: true,
    is_combo: true,
    combo_eligible: false,
    combo_price_override: 400,
  });

  const martesBeersSlotId = await upsertComboSlot({
    combo_product_id: martesCubetaId,
    label: 'Beers',
    slot_type: 'product',
    min_qty: 6,
    max_qty: 6,
    is_required: true,
    sort_order: 0,
  });

  await populateOptionsFromCategory(martesBeersSlotId, regularCategoryId);

  const martesPoolSlotId = await upsertComboSlot({
    combo_product_id: martesCubetaId,
    label: 'Pool Time',
    slot_type: 'pool_time',
    min_qty: 1,
    max_qty: 1,
    is_required: true,
    sort_order: 1,
  });

  await upsertSlotOption({
    combo_slot_id: martesPoolSlotId,
    child_product_id: null,
    prepaid_minutes: 60,
    sort_order: 0,
  });

  // Availability: Tuesday only (ISO day 2)
  // Delete existing rows then re-insert (availability rows have no natural key to upsert on)
  await db.from('combo_availability').delete().eq('combo_product_id', martesCubetaId);
  const { error: availErr } = await db.from('combo_availability').insert({
    combo_product_id: martesCubetaId,
    days_of_week: [2], // Tuesday
    start_time: null,
    end_time: null,
    start_date: null,
    end_date: null,
  });
  if (availErr) {
    console.error('Failed to insert combo_availability for Martes de Cubeta + Pool:', availErr);
    process.exit(1);
  }

  console.log('Combo seed complete:');
  console.log('  - Cubeta Regular:', cubetaRegularId);
  console.log('  - Cubeta Premium:', cubetaPremiumId);
  console.log('  - Martes de Cubeta + Pool:', martesCubetaId);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

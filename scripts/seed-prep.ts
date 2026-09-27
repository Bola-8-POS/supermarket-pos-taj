/**
 * seed-prep.ts
 *
 * Seeds prep ingredients (Salsa Mexicana, Michelada Mix), raw ingredients
 * (Tomato, Onion, Lime Juice), and prep recipes linking each prep ingredient to
 * its raw ingredients.
 *
 * Run: cd bar-pos && npx tsx scripts/seed-prep.ts
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * IMPORTANT: Uses service role key (bypasses RLS). Only run in dev/staging.
 * Never commit .env.local or hardcode keys.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local from bar-pos/ directory
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing VITE_SUPABASE_URL (or SUPABASE_URL) and/or SUPABASE_SERVICE_ROLE_KEY in environment');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;

async function seedIngredient(params: {
  name: string;
  uom: string;
  isPrep: boolean;
  qtyOnHand: number;
  reorderPoint?: number;
}): Promise<string> {
  // Select-then-upsert pattern (idempotent)
  const { data: existing, error: selectErr } = await db
    .from('ingredients')
    .select('id')
    .eq('name', params.name)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`Failed to check ingredient "${params.name}": ${selectErr.message}`);
  }

  if (existing) {
    // Update qty_on_hand to seed value (reset for repeatable tests)
    const { error: updateErr } = await db
      .from('ingredients')
      .update({
        quantity_on_hand: params.qtyOnHand,
        is_prep: params.isPrep,
        reorder_point: params.reorderPoint ?? null,
      })
      .eq('id', existing.id);
    if (updateErr) {
      throw new Error(`Failed to update ingredient "${params.name}": ${updateErr.message}`);
    }
    console.log(`  [UPDATED] ${params.name} (id=${existing.id})`);
    return existing.id as string;
  }

  const { data, error } = await db
    .from('ingredients')
    .insert({
      name: params.name,
      uom: params.uom,
      is_prep: params.isPrep,
      quantity_on_hand: params.qtyOnHand,
      reorder_point: params.reorderPoint ?? null,
      purchase_to_base_factor: 1,
      cost_per_base_unit: 0,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to insert ingredient "${params.name}": ${error.message}`);
  console.log(`  [CREATED] ${params.name} (id=${data.id})`);
  return data.id as string;
}

async function seedPrepRecipe(
  prepIngredientId: string,
  items: Array<{ ingredientId: string; qty: number }>,
  yieldQty = 1,
): Promise<string> {
  // Select-then-upsert on prep_ingredient_id (partial unique index — upsert with onConflict
  // may not work reliably; use select-then-insert/update pattern)
  const { data: existing, error: selectErr } = await db
    .from('recipes')
    .select('id')
    .eq('prep_ingredient_id', prepIngredientId)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`Failed to check prep recipe: ${selectErr.message}`);
  }

  let recipeId: string;
  if (existing) {
    recipeId = existing.id;
    const { error: updateErr } = await db
      .from('recipes')
      .update({ yield_qty: yieldQty })
      .eq('id', recipeId);
    if (updateErr) {
      throw new Error(`Failed to update prep recipe (id=${recipeId}): ${updateErr.message}`);
    }
    console.log(`  [UPDATED] prep recipe (id=${recipeId})`);
  } else {
    const { data, error } = await db
      .from('recipes')
      .insert({ prep_ingredient_id: prepIngredientId, yield_qty: yieldQty })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to insert prep recipe: ${error.message}`);
    recipeId = data.id;
    console.log(`  [CREATED] prep recipe (id=${recipeId})`);
  }

  // Replace recipe items (idempotent: delete all then insert)
  await db.from('recipe_items').delete().eq('recipe_id', recipeId);
  if (items.length > 0) {
    const { error: insertErr } = await db.from('recipe_items').insert(
      items.map(item => ({ recipe_id: recipeId, ingredient_id: item.ingredientId, qty: item.qty })),
    );
    if (insertErr) throw new Error(`Failed to insert recipe items: ${insertErr.message}`);
  }
  console.log(`  [OK]   ${items.length} recipe item(s) for recipe ${recipeId}`);
  return recipeId;
}

async function main(): Promise<void> {
  console.log('Seeding prep ingredients + prep-owned recipes…\n');

  // --- Prep ingredients (is_prep=true) ---
  console.log('Prep ingredients:');
  const salsaId = await seedIngredient({
    name: 'Salsa Mexicana',
    uom: 'portion',
    isPrep: true,
    qtyOnHand: 0,
    reorderPoint: 5,
  });

  const micheladaMixId = await seedIngredient({
    name: 'Michelada Mix',
    uom: 'L',
    isPrep: true,
    qtyOnHand: 0,
    reorderPoint: 2,
  });

  // --- Raw ingredients (is_prep=false) ---
  console.log('\nRaw ingredients:');
  const tomatoId = await seedIngredient({
    name: 'Tomato',
    uom: 'g',
    isPrep: false,
    qtyOnHand: 2000,
    reorderPoint: 500,
  });

  const onionId = await seedIngredient({
    name: 'Onion',
    uom: 'g',
    isPrep: false,
    qtyOnHand: 300,
    reorderPoint: 100,
  });

  const limeJuiceId = await seedIngredient({
    name: 'Lime Juice',
    uom: 'ml',
    isPrep: false,
    qtyOnHand: 500,
    reorderPoint: 100,
  });

  // --- Prep recipes ---
  console.log('\nPrep recipes:');
  // Salsa Mexicana = 100g tomato + 10g onion per portion (yield=1)
  await seedPrepRecipe(
    salsaId,
    [
      { ingredientId: tomatoId, qty: 100 },
      { ingredientId: onionId, qty: 10 },
    ],
    1,
  );

  // Michelada Mix = 200ml lime juice per litre (yield=1)
  await seedPrepRecipe(
    micheladaMixId,
    [{ ingredientId: limeJuiceId, qty: 200 }],
    1,
  );

  console.log('\nSeed complete!');
  console.log(`  Salsa Mexicana: ${salsaId}`);
  console.log(`  Michelada Mix: ${micheladaMixId}`);
  console.log(`  Tomato: ${tomatoId}`);
  console.log(`  Onion: ${onionId}`);
  console.log(`  Lime Juice: ${limeJuiceId}`);
}

void main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

/**
 * Indian grocery baseline data for remote development and E2E environments.
 *
 * Idempotent by category/product/modifier name. Existing inventory is never
 * overwritten because it may be live stock rather than fixture data.
 *
 * Usage: npx tsx scripts/seed-dev-data.ts
 * Requires: VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local'
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

async function upsertCategory(data: {
  name: string;
  routing: 'KITCHEN' | 'BAR' | 'NONE';
  sort_order: number;
  color?: string;
}): Promise<string> {
  const { data: existing } = await db
    .from('categories')
    .select('id')
    .eq('name', data.name)
    .maybeSingle();
  if (existing) {
    await db.from('categories').update(data).eq('id', existing.id);
    return existing.id as string;
  }
  const { data: inserted, error } = await db.from('categories').insert(data).select('id').single();
  if (error) {
    console.error(`Failed to insert category "${data.name}":`, error);
    process.exit(1);
  }
  return (inserted as { id: string }).id;
}

async function upsertProduct(data: {
  name: string;
  category_id: string;
  base_price: number;
  sku: string;
  barcode: string;
  is_active: boolean;
  sold_by_weight: boolean;
  stock_threshold: number;
  units_per_package: null;
  parent_product_id: null;
}): Promise<string> {
  const { data: existing } = await db
    .from('products')
    .select('id')
    .eq('name', data.name)
    .maybeSingle();
  if (existing) {
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

async function upsertModifier(data: { name: string; price_delta: number }): Promise<string> {
  const { data: existing } = await db
    .from('modifiers')
    .select('id')
    .eq('name', data.name)
    .maybeSingle();
  if (existing) {
    await db.from('modifiers').update(data).eq('id', existing.id);
    return existing.id as string;
  }
  const { data: inserted, error } = await db.from('modifiers').insert(data).select('id').single();
  if (error) {
    console.error(`Failed to insert modifier "${data.name}":`, error);
    process.exit(1);
  }
  return (inserted as { id: string }).id;
}

async function linkModifier(productId: string, modifierId: string): Promise<void> {
  const { data: existing } = await db
    .from('product_modifiers')
    .select('product_id')
    .eq('product_id', productId)
    .eq('modifier_id', modifierId)
    .maybeSingle();
  if (existing) return;
  const { error } = await db
    .from('product_modifiers')
    .insert({ product_id: productId, modifier_id: modifierId });
  if (error) console.error(`Failed to link modifier ${modifierId} to product ${productId}:`, error);
}

async function ensureInventory(
  productId: string,
  quantity: number,
  lowStockThreshold: number,
  costPrice: number,
  expiryDays: number
): Promise<void> {
  const { data: existing } = await db
    .from('inventory')
    .select('id')
    .eq('product_id', productId)
    .maybeSingle();
  if (existing) return;
  const { error } = await db.from('inventory').insert({
    product_id: productId,
    quantity_on_hand: quantity,
    low_stock_threshold: lowStockThreshold,
    cost_price: costPrice,
    expiry_date: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  if (error) console.error(`Failed to insert inventory for product ${productId}:`, error);
}

const packaged = (
  name: string,
  category_id: string,
  base_price: number,
  sku: string,
  barcode: string
) => ({
  name,
  category_id,
  base_price,
  sku,
  barcode,
  is_active: true,
  sold_by_weight: false,
  stock_threshold: 15,
  units_per_package: null,
  parent_product_id: null,
});

async function main() {
  console.log('Seeding Indian grocery dev data...');
  const masalas = await upsertCategory({ name: 'Masalas', routing: 'NONE', sort_order: 1 });
  const staples = await upsertCategory({ name: 'Atta/Rice/Dals', routing: 'NONE', sort_order: 2 });
  const snacks = await upsertCategory({ name: 'Snacks', routing: 'NONE', sort_order: 3 });
  const pickles = await upsertCategory({ name: 'Pickles/Papads', routing: 'NONE', sort_order: 4 });
  const oils = await upsertCategory({ name: 'Ghee/Oil', routing: 'NONE', sort_order: 5 });
  const beverages = await upsertCategory({ name: 'Tea/Coffee', routing: 'NONE', sort_order: 6 });
  const frozen = await upsertCategory({ name: 'Frozen', routing: 'NONE', sort_order: 7 });
  const readyToEat = await upsertCategory({ name: 'Ready-to-Eat', routing: 'NONE', sort_order: 8 });
  const sweets = await upsertCategory({ name: 'Sweets', routing: 'NONE', sort_order: 9 });

  const garamMasala = await upsertProduct(
    packaged('MDH Garam Masala 100g', masalas, 85, 'MAS-001', '8901030800001')
  );
  const chanaMasala = await upsertProduct(
    packaged('Everest Chana Masala 100g', masalas, 75, 'MAS-002', '8901030800002')
  );
  const biryaniMasala = await upsertProduct(
    packaged('Shan Biryani Masala 50g', masalas, 55, 'MAS-003', '8901030800003')
  );
  const atta = await upsertProduct(
    packaged('Aashirvaad Atta 5kg', staples, 330, 'STP-001', '8901030800004')
  );
  const basmatiRice = await upsertProduct(
    packaged('India Gate Basmati Rice 5kg', staples, 560, 'STP-002', '8901030800005')
  );
  const toorDal = await upsertProduct(
    packaged('Toor Dal 1kg', staples, 165, 'STP-003', '8901030800006')
  );
  const alooBhujia = await upsertProduct(
    packaged("Haldiram's Aloo Bhujia 200g", snacks, 55, 'SNK-001', '8901030800007')
  );
  const parleG = await upsertProduct(
    packaged('Parle-G Biscuits 200g', snacks, 35, 'SNK-002', '8901030800008')
  );
  const navrattanMix = await upsertProduct(
    packaged("Haldiram's Navrattan Mix 200g", snacks, 60, 'SNK-003', '8901030800009')
  );
  const mangoPickle = await upsertProduct(
    packaged("Mother's Recipe Mango Pickle 400g", pickles, 125, 'PKL-001', '8901030800010')
  );
  const lijjatPapad = await upsertProduct(
    packaged('Lijjat Papad 200g', pickles, 80, 'PKL-002', '8901030800011')
  );
  const limePickle = await upsertProduct(
    packaged('Priya Lime Pickle 300g', pickles, 95, 'PKL-003', '8901030800012')
  );
  const pureGhee = await upsertProduct(
    packaged('Amul Pure Ghee 500ml', oils, 325, 'OIL-001', '8901030800013')
  );
  const sunflowerOil = await upsertProduct(
    packaged('Fortune Sunflower Oil 1L', oils, 155, 'OIL-002', '8901030800014')
  );
  const mustardOil = await upsertProduct(
    packaged('Dhara Mustard Oil 1L', oils, 175, 'OIL-003', '8901030800015')
  );
  const tataTea = await upsertProduct(
    packaged('Tata Tea Gold 250g', beverages, 125, 'BEV-001', '8901030800016')
  );
  const bruCoffee = await upsertProduct(
    packaged('Bru Instant Coffee 100g', beverages, 120, 'BEV-002', '8901030800017')
  );
  const redLabel = await upsertProduct(
    packaged('Brooke Bond Red Label 250g', beverages, 95, 'BEV-003', '8901030800018')
  );
  const frozenPeas = await upsertProduct(
    packaged('McCain Frozen Peas 500g', frozen, 145, 'FRZ-001', '8901030800019')
  );
  const frozenParatha = await upsertProduct(
    packaged('Godrej Yummiez Frozen Paratha 400g', frozen, 165, 'FRZ-002', '8901030800020')
  );
  const frozenSamosa = await upsertProduct(
    packaged("Haldiram's Frozen Samosa 400g", frozen, 180, 'FRZ-003', '8901030800021')
  );
  const mtrPoha = await upsertProduct(
    packaged('MTR Poha 80g', readyToEat, 45, 'RTE-001', '8901030800022')
  );
  const rajma = await upsertProduct(
    packaged("Haldiram's Ready to Eat Rajma 285g", readyToEat, 85, 'RTE-002', '8901030800023')
  );
  const upma = await upsertProduct(
    packaged('MTR Upma 160g', readyToEat, 60, 'RTE-003', '8901030800024')
  );
  const soanPapdi = await upsertProduct(
    packaged("Haldiram's Soan Papdi 250g", sweets, 175, 'SWT-001', '8901030800025')
  );
  const gulabJamun = await upsertProduct(
    packaged('Bikaji Gulab Jamun 1kg', sweets, 280, 'SWT-002', '8901030800026')
  );
  const kajuKatli = await upsertProduct(
    packaged("Haldiram's Kaju Katli 250g", sweets, 300, 'SWT-003', '8901030800027')
  );

  const extraSpicy = await upsertModifier({ name: 'Extra Spicy', price_delta: 0 });
  await linkModifier(alooBhujia, extraSpicy);

  await ensureInventory(garamMasala, 100, 15, 65, 180);
  await ensureInventory(chanaMasala, 90, 15, 55, 180);
  await ensureInventory(biryaniMasala, 80, 15, 40, 120);
  await ensureInventory(atta, 45, 10, 250, 120);
  await ensureInventory(basmatiRice, 40, 10, 450, 300);
  await ensureInventory(toorDal, 60, 15, 125, 240);
  await ensureInventory(alooBhujia, 100, 15, 40, 60);
  await ensureInventory(parleG, 150, 20, 25, 150);
  await ensureInventory(navrattanMix, 90, 15, 45, 60);
  await ensureInventory(mangoPickle, 50, 10, 95, 240);
  await ensureInventory(lijjatPapad, 70, 10, 60, 180);
  await ensureInventory(limePickle, 45, 10, 70, 240);
  await ensureInventory(pureGhee, 40, 10, 270, 300);
  await ensureInventory(sunflowerOil, 80, 15, 125, 270);
  await ensureInventory(mustardOil, 60, 15, 140, 270);
  await ensureInventory(tataTea, 100, 15, 95, 300);
  await ensureInventory(bruCoffee, 75, 15, 90, 300);
  await ensureInventory(redLabel, 90, 15, 70, 300);
  await ensureInventory(frozenPeas, 40, 10, 115, 7);
  await ensureInventory(frozenParatha, 35, 10, 130, 10);
  await ensureInventory(frozenSamosa, 30, 10, 145, 7);
  await ensureInventory(mtrPoha, 100, 15, 35, 150);
  await ensureInventory(rajma, 75, 15, 65, 180);
  await ensureInventory(upma, 80, 15, 45, 150);
  await ensureInventory(soanPapdi, 45, 10, 140, 120);
  await ensureInventory(gulabJamun, 30, 10, 220, 90);
  await ensureInventory(kajuKatli, 25, 10, 240, 60);
  console.log('Indian grocery dev data seed complete.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

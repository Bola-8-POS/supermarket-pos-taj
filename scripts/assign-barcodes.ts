/**
 * Assigns a unique EAN-13 barcode to every active product missing one.
 *
 * Uniqueness matters here: useLookupProductByBarcode.ts does an exact-match
 * `products.barcode = code` query, so a duplicate would make the scanner
 * resolve to whichever row Postgres returns first — this script guarantees
 * one barcode maps to exactly one active product.
 *
 * Usage: npx tsx scripts/assign-barcodes.ts [--dry-run] [--all]
 *   --all  also regenerates products that already have a barcode (use when
 *          the existing codes aren't valid/unique EAN-13, e.g. seed data
 *          whose check digits collide once corrected).
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

const dryRun = process.argv.includes('--dry-run');
const regenAll = process.argv.includes('--all');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

// Internal-use prefix (200) keeps generated codes visually distinct from any
// real manufacturer EAN-13 that gets entered later via receiving.
const PREFIX = '200';

// Not a physical shelf item — never barcode it.
const SKIP_NAMES = new Set(['Rappi / external item']);

function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function makeBarcode(seq: number): string {
  const body = String(seq).padStart(9, '0'); // PREFIX(3) + body(9) = 12 digits
  const digits12 = PREFIX + body;
  return digits12 + String(ean13CheckDigit(digits12));
}

async function main() {
  const { data: products, error } = await db
    .from('products')
    .select('id, name, barcode, is_active')
    .eq('is_active', true)
    .order('name');
  if (error) {
    console.error('Failed to fetch products:', error);
    process.exit(1);
  }

  const eligible = (products as any[]).filter(p => !SKIP_NAMES.has(p.name));
  const needsBarcode = regenAll ? eligible : eligible.filter(p => !p.barcode);
  const existingCodes = new Set<string>(
    regenAll ? [] : eligible.map(p => p.barcode).filter((b): b is string => !!b)
  );

  console.log(
    `${products.length} active products, ${needsBarcode.length} to ${regenAll ? 'regenerate' : 'assign'}.`
  );
  if (needsBarcode.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let seq = 1;
  const assignments: { id: string; name: string; barcode: string }[] = [];
  for (const product of needsBarcode) {
    let code = makeBarcode(seq++);
    while (existingCodes.has(code)) {
      code = makeBarcode(seq++);
    }
    existingCodes.add(code);
    assignments.push({ id: product.id, name: product.name, barcode: code });
  }

  console.log(dryRun ? '\n[dry run] would assign:' : '\nAssigning:');
  for (const a of assignments) {
    console.log(`  ${a.barcode}  ${a.name}`);
  }

  if (dryRun) return;

  for (const a of assignments) {
    const { error: updateError } = await db
      .from('products')
      .update({ barcode: a.barcode })
      .eq('id', a.id);
    if (updateError) {
      console.error(`Failed to update "${a.name}" (${a.id}):`, updateError);
      process.exit(1);
    }
  }

  console.log(`\nDone. ${assignments.length} products updated.`);
}

main();

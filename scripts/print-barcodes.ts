/**
 * Renders every active product's barcode onto an A4 print sheet (HTML).
 *
 * EAN-13 bars are hand-encoded here (no barcode library — this is a
 * throwaway test artifact for scanner hardware verification, not app code).
 * Open the generated file and print via the browser's Ctrl+P dialog to the
 * Brother DCP printer.
 *
 * Usage: npx tsx scripts/print-barcodes.ts
 * Requires: VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 * Output: scratchpad/barcode-sheet.html
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

// Standard EAN-13 encoding tables (left-odd, left-even, right), 7 modules each.
const L_ODD: Record<string, string> = {
  '0': '0001101',
  '1': '0011001',
  '2': '0010011',
  '3': '0111101',
  '4': '0100011',
  '5': '0110001',
  '6': '0101111',
  '7': '0111011',
  '8': '0110111',
  '9': '0001011',
};
const L_EVEN: Record<string, string> = {
  '0': '0100111',
  '1': '0110011',
  '2': '0011011',
  '3': '0100001',
  '4': '0011101',
  '5': '0111001',
  '6': '0000101',
  '7': '0010001',
  '8': '0001001',
  '9': '0010111',
};
const R_CODE: Record<string, string> = {
  '0': '1110010',
  '1': '1100110',
  '2': '1101100',
  '3': '1000010',
  '4': '1011100',
  '5': '1001110',
  '6': '1010000',
  '7': '1000100',
  '8': '1001000',
  '9': '1110100',
};
// Parity pattern per first digit, for digits 2-7 of the left half.
const PARITY: Record<string, string> = {
  '0': 'OOOOOO',
  '1': 'OOEOEE',
  '2': 'OOEEOE',
  '3': 'OOEEEO',
  '4': 'OEOOEE',
  '5': 'OEEOOE',
  '6': 'OEEEOO',
  '7': 'OEOEOE',
  '8': 'OEOEEO',
  '9': 'OEEOEO',
};

function ean13ToBits(code: string): string {
  if (!/^\d{13}$/.test(code)) throw new Error(`Not a 13-digit EAN-13: ${code}`);
  const first = code[0]!;
  const left = code.slice(1, 7);
  const right = code.slice(7, 13);
  const parity = PARITY[first]!;
  let bits = '101'; // start guard
  for (let i = 0; i < 6; i++) {
    const digit = left[i]!;
    bits += parity[i] === 'O' ? L_ODD[digit]! : L_EVEN[digit]!;
  }
  bits += '01010'; // center guard
  for (let i = 0; i < 6; i++) {
    bits += R_CODE[right[i]!]!;
  }
  bits += '101'; // end guard
  return bits;
}

function barcodeSvg(code: string): string {
  const bits = ean13ToBits(code);
  const moduleWidth = 2;
  const barHeight = 60;
  const width = bits.length * moduleWidth;
  let rects = '';
  let x = 0;
  for (const bit of bits) {
    if (bit === '1') {
      rects += `<rect x="${x}" y="0" width="${moduleWidth}" height="${barHeight}" fill="black"/>`;
    }
    x += moduleWidth;
  }
  return `<svg width="${width}" height="${barHeight}" viewBox="0 0 ${width} ${barHeight}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

async function main() {
  const { data: products, error } = await db
    .from('products')
    .select('id, name, barcode')
    .eq('is_active', true)
    .not('barcode', 'is', null)
    .order('name');
  if (error) {
    console.error('Failed to fetch products:', error);
    process.exit(1);
  }

  const cells = (products as any[])
    .filter(p => /^\d{13}$/.test(p.barcode ?? ''))
    .map(
      p => `
      <div class="cell">
        ${barcodeSvg(p.barcode)}
        <div class="code">${p.barcode}</div>
        <div class="name">${escapeHtml(p.name)}</div>
      </div>`
    )
    .join('\n');

  const skipped = (products as any[]).filter(p => !/^\d{13}$/.test(p.barcode ?? ''));
  if (skipped.length) {
    console.warn(
      `Skipped ${skipped.length} product(s) with a non-13-digit barcode:`,
      skipped.map(p => `${p.name} (${p.barcode})`)
    );
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Barcode sheet</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, sans-serif; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
  .cell {
    border: 1px dashed #ccc;
    padding: 4mm;
    text-align: center;
    break-inside: avoid;
  }
  .cell svg { display: block; margin: 0 auto; }
  .code { font-size: 11px; letter-spacing: 2px; margin-top: 2px; }
  .name { font-size: 12px; font-weight: bold; margin-top: 2px; }
</style>
</head>
<body>
  <div class="grid">
    ${cells}
  </div>
</body>
</html>`;

  const outDir = path.resolve(__dirname, '../scratchpad');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'barcode-sheet.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(`Wrote ${outPath} (${(products as any[]).length - skipped.length} barcodes).`);
  console.log('Open it in a browser and Ctrl+P to print to the Brother DCP.');
}

main();

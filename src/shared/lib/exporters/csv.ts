// Generic rows->CSV serializer (D-11). Reuses xlsx's own sheet writer so RFC-4180
// escaping (commas, quotes, newlines) is never hand-rolled here.
import * as XLSX from 'xlsx';

export type CsvColumn<T> = { key: keyof T; header: string };

// CWE-1236: neutralize formula-prefixed cells (=,+,-,@,tab,CR) so Excel/Sheets
// never interprets free-text values (reason, staffName, ...) as live formulas.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function sanitizeCsvCell(value: unknown): unknown {
  return typeof value === 'string' && FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function rowsToCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: CsvColumn<T>[]
): string {
  const mapped = rows.map(row =>
    Object.fromEntries(columns.map(c => [c.header, sanitizeCsvCell(row[c.key])]))
  );
  const ws = XLSX.utils.json_to_sheet(mapped, { header: columns.map(c => c.header) });
  return XLSX.utils.sheet_to_csv(ws);
}

export function csvToBytes(csv: string): Uint8Array {
  return new TextEncoder().encode(csv);
}

/**
 * Unit tests for the generic CSV serializer (src/shared/lib/exporters/csv.ts)
 *
 * All functions are pure (no I/O). Tests verify RFC-4180 escaping is delegated to
 * xlsx's own sheet_to_csv writer, not hand-rolled here.
 */

import { describe, expect, it } from 'vitest';
import { rowsToCsv, csvToBytes, type CsvColumn } from './csv';

type Row = { a: number; b: string };
const COLUMNS: CsvColumn<Row>[] = [
  { key: 'a', header: 'A' },
  { key: 'b', header: 'B' },
];

function splitRows(csv: string): string[] {
  return csv.trim().split(/\r\n|\n/);
}

describe('rowsToCsv', () => {
  it('produces a header row then a data row', () => {
    const csv = rowsToCsv<Row>([{ a: 1, b: 'x' }], COLUMNS);
    const lines = splitRows(csv);
    expect(lines[0]).toBe('A,B');
    expect(lines[1]).toBe('1,x');
  });

  it('wraps a cell value containing a comma in double quotes', () => {
    const csv = rowsToCsv<Row>([{ a: 1, b: 'x,y' }], COLUMNS);
    expect(csv).toContain('"x,y"');
  });

  it('doubles an embedded double quote per RFC 4180', () => {
    const csv = rowsToCsv<Row>([{ a: 1, b: 'say "hi"' }], COLUMNS);
    expect(csv).toContain('"say ""hi"""');
  });

  it('quotes a cell value containing a newline instead of splitting rows', () => {
    const csv = rowsToCsv<Row>([{ a: 1, b: 'line1\nline2' }], COLUMNS);
    // the embedded newline must stay inside quotes on the data row, not become
    // its own bare CSV row (a naive split on \n would wrongly show 3 lines)
    expect(csv).toContain('"line1\nline2"');
    expect(csv.startsWith('A,B')).toBe(true);
  });

  it.each(['=cmd', '+1+1', '-1', '@SUM(A1)', '\tevil', '\revil'])(
    'prefixes formula-injection value %s with a single quote (CWE-1236)',
    formulaValue => {
      const csv = rowsToCsv<Row>([{ a: 1, b: formulaValue }], COLUMNS);
      expect(csv).toContain(`'${formulaValue}`);
    }
  );

  it('leaves a normal value untouched', () => {
    const csv = rowsToCsv<Row>([{ a: 1, b: 'Refund - no stock' }], COLUMNS);
    expect(csv).toContain('Refund - no stock');
  });

  it('follows column order in config, not object key order', () => {
    const reversedColumns: CsvColumn<Row>[] = [
      { key: 'b', header: 'B' },
      { key: 'a', header: 'A' },
    ];
    const csv = rowsToCsv<Row>([{ a: 1, b: 'x' }], reversedColumns);
    const lines = splitRows(csv);
    expect(lines[0]).toBe('B,A');
    expect(lines[1]).toBe('x,1');
  });
});

describe('csvToBytes', () => {
  it('returns a Uint8Array whose decoded text equals the input string', () => {
    const csv = 'A,B\r\n1,x\r\n';
    const bytes = csvToBytes(csv);
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(new TextDecoder().decode(bytes)).toBe(csv);
  });
});

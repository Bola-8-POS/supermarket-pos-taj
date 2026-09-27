/**
 * QA unit tests for voidRefundToWorkbook — AC-3 of POS-4
 * Verifies Excel export has identical columns to the VoidRefundPanel table.
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { VoidRefundRow } from '@shared/lib/domain';
import { voidRefundToWorkbook } from './excel';

const twoVoids: VoidRefundRow[] = [
  {
    orderId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    voidedAt: new Date('2026-04-21T14:30:00Z'),
    staffName: 'Alice',
    amount: 45.5,
    reason: 'Customer changed mind',
  },
  {
    orderId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    voidedAt: new Date('2026-04-21T18:00:00Z'),
    staffName: 'Bob',
    amount: 20.0,
    reason: 'Entered on wrong tab',
  },
];

const dateRange = {
  from: new Date('2026-04-21T00:00:00'),
  to: new Date('2026-04-21T23:59:59'),
};

// Table columns from VoidRefundPanel: Timestamp | Staff | Amount | Reason
const EXPECTED_HEADERS = ['Timestamp', 'Staff', 'Amount', 'Reason'];

describe('voidRefundToWorkbook — AC-3 column parity', () => {
  it('workbook has a "Voids & Refunds" sheet', () => {
    const wb = voidRefundToWorkbook(twoVoids, dateRange);
    expect(wb.SheetNames).toContain('Voids & Refunds');
  });

  it('header row matches VoidRefundPanel table columns exactly', () => {
    const wb = voidRefundToWorkbook(twoVoids, dateRange);
    const ws = wb.Sheets['Voids & Refunds'];
    if (!ws) throw new Error('Sheet "Voids & Refunds" missing');

    // Row 3 (0-indexed row 2) is the header row (rows 0-1 are title + blank)
    const headerRow = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, range: 2 })[0];

    // Must have exactly: Timestamp, Staff, Amount, Reason
    expect(headerRow).toEqual(EXPECTED_HEADERS);
  });

  it('data rows include correct staffName and reason values', () => {
    const wb = voidRefundToWorkbook(twoVoids, dateRange);
    const ws = wb.Sheets['Voids & Refunds'];
    if (!ws) throw new Error('Sheet "Voids & Refunds" missing');

    // Data rows start at row 4 (0-indexed row 3)
    const allRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // Find the row with Alice
    const aliceRow = allRows.find(r => Array.isArray(r) && r.includes('Alice'));
    expect(aliceRow).toBeDefined();
    expect(aliceRow).toContain('Customer changed mind');

    const bobRow = allRows.find(r => Array.isArray(r) && r.includes('Bob'));
    expect(bobRow).toBeDefined();
    expect(bobRow).toContain('Entered on wrong tab');
  });

  it('produces an empty data section (header only) when rows array is empty', () => {
    const wb = voidRefundToWorkbook([], dateRange);
    const ws = wb.Sheets['Voids & Refunds'];
    if (!ws) throw new Error('Sheet "Voids & Refunds" missing');

    const allRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // Should have at most 3 rows: title, blank, header
    expect(allRows.length).toBeLessThanOrEqual(3);

    // Header row (index 2) must still exist with correct columns
    const headerRow = allRows[2];
    expect(headerRow).toEqual(EXPECTED_HEADERS);
  });
});

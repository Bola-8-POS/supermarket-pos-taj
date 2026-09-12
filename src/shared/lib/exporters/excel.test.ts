/**
 * Unit tests for Excel workbook builders (src/shared/lib/exporters/excel.ts)
 *
 * All functions are pure (no I/O). Tests verify sheet structure and data integrity.
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { CajaReport, HourlyRow, ProductSalesRow } from '@shared/lib/domain';
import {
  cajaReportToWorkbook,
  hourlySalesToWorkbook,
  productSalesToWorkbook,
  workbookToBytes,
} from './excel';

// ============================================================================
// Fixture factories
// ============================================================================

function makeCajaReport(overrides: Partial<CajaReport> = {}): CajaReport {
  const base: CajaReport = {
    cajaSession: {
      id: '00000000-0000-0000-0000-000000000001',
      openedAt: new Date('2024-03-15T08:00:00Z'),
      closedAt: null,
      openedBy: '00000000-0000-0000-0000-000000000002',
      closedBy: null,
      openingCash: 500,
      closingCash: null,
      notes: null,
      status: 'open',
    },
    summary: {
      totalRevenue: 1500.5,
      cashSales: 800.25,
      cardSales: 600.25,
      rappiSales: 100,
      uberEatsSales: 0,
      bankTransferSales: 0,
      bankTransferPending: 0,
      orderCount: 30,
      tabCount: 12,
      totalExpenses: 200,
      totalIncome: 50,
      netBalance: 1350.5,
    },
    cashReconciliation: {
      openingCash: 500,
      cashSales: 800.25,
      expectedCash: 1300.25,
      closingCash: null,
      variance: null,
    },
    topProducts: [
      { productName: 'Corona', quantity: 20, revenue: 600 },
      { productName: 'Modelo', quantity: 15, revenue: 450 },
    ],
    staffSummary: [
      {
        staffId: '00000000-0000-0000-0000-000000000003',
        staffName: 'Alex',
        orderCount: 20,
        salesTotal: 900,
      },
    ],
    cajaEntries: [],
  };
  return { ...base, ...overrides };
}

function makeProductRows(count = 3): ProductSalesRow[] {
  return Array.from({ length: count }, (_, i) => ({
    productId: `prod-${String(i)}`,
    productName: `Product ${String(i + 1)}`,
    categoryName: `Category ${String(Math.floor(i / 2) + 1)}`,
    units: (i + 1) * 5,
    revenue: (i + 1) * 100,
    costTotal: (i + 1) * 60,
    margin: (i + 1) * 40,
    marginPct: 40,
    pctTotal: ((i + 1) * 100) / 600,
  }));
}

function makeHourlyRows(count = 24): HourlyRow[] {
  return Array.from({ length: count }, (_, i) => ({
    hour: i,
    orderCount: i * 2,
    revenue: i * 50,
    dayOfWeek: i % 7,
    isBusiest: i === count - 1,
  }));
}

// ============================================================================
// cajaReportToWorkbook
// ============================================================================

describe('cajaReportToWorkbook', () => {
  it('Summary sheet has correct column headers', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);

    const ws = wb.Sheets['Summary'] as XLSX.WorkSheet;
    expect(ws).toBeDefined();

    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    const headerRow = data[0] as string[];
    expect(headerRow).toContain('Metric');
    expect(headerRow).toContain('Value');
  });

  it('revenue values match input (2 decimal precision)', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);

    const ws = wb.Sheets['Summary'] as XLSX.WorkSheet;
    // B2 is Total Revenue — check the cell value directly
    const cell = ws['B2'] as XLSX.CellObject;
    expect(cell).toBeDefined();
    expect(cell.v).toBe(report.summary.totalRevenue);
  });

  it('Top Products sheet row count matches topProducts array', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);

    const ws = wb.Sheets['Top Products'] as XLSX.WorkSheet;
    expect(ws).toBeDefined();

    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // First row is header; remaining rows are data
    expect(data.length - 1).toBe(report.topProducts.length);
  });

  it('Top Products sheet header has correct columns', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);

    const ws = wb.Sheets['Top Products'] as XLSX.WorkSheet;
    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    const headerRow = data[0] as string[];
    expect(headerRow).toContain('Product Name');
    expect(headerRow).toContain('Quantity');
    expect(headerRow).toContain('Revenue');
  });
});

// ============================================================================
// productSalesToWorkbook
// ============================================================================

describe('productSalesToWorkbook', () => {
  it('column mapping: productName, quantity, revenue present', () => {
    const rows = makeProductRows(2);
    const dateRange = { from: new Date('2024-03-01'), to: new Date('2024-03-31') };
    const wb = productSalesToWorkbook(rows, dateRange);

    const ws = wb.Sheets['Product Sales'] as XLSX.WorkSheet;
    expect(ws).toBeDefined();

    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // Row 0 = title row, Row 1 = empty, Row 2 = column headers
    const colHeaderRow = data[2] as string[];
    expect(colHeaderRow).toContain('Product Name');
    expect(colHeaderRow).toContain('Units Sold');
    expect(colHeaderRow).toContain('Revenue');
    expect(colHeaderRow).toContain('Margin');
  });

  it('data rows match input row count', () => {
    const rows = makeProductRows(5);
    const dateRange = { from: new Date('2024-03-01'), to: new Date('2024-03-31') };
    const wb = productSalesToWorkbook(rows, dateRange);

    const ws = wb.Sheets['Product Sales'] as XLSX.WorkSheet;
    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // 3 header rows (title, empty, col headers) + data rows
    expect(data.length - 3).toBe(rows.length);
  });
});

// ============================================================================
// hourlySalesToWorkbook
// ============================================================================

describe('hourlySalesToWorkbook', () => {
  it('correct row count when given 24 hourly entries', () => {
    const rows = makeHourlyRows(24);
    const wb = hourlySalesToWorkbook(rows);

    const ws = wb.Sheets['Hourly Sales'] as XLSX.WorkSheet;
    expect(ws).toBeDefined();

    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // First row is header; remaining 24 rows are data
    expect(data.length - 1).toBe(24);
  });

  it('header has Hour, Day of Week, Orders, Revenue, Busiest columns', () => {
    const rows = makeHourlyRows(1);
    const wb = hourlySalesToWorkbook(rows);

    const ws = wb.Sheets['Hourly Sales'] as XLSX.WorkSheet;
    const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    const headerRow = data[0] as string[];
    expect(headerRow).toContain('Hour');
    expect(headerRow).toContain('Day of Week');
    expect(headerRow).toContain('Orders');
    expect(headerRow).toContain('Revenue');
    expect(headerRow).toContain('Busiest');
  });
});

// ============================================================================
// workbookToBytes
// ============================================================================

describe('workbookToBytes', () => {
  it('returns non-empty Uint8Array', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);
    const bytes = workbookToBytes(wb);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('bytes start with XLSX magic bytes (PK zip header)', () => {
    const report = makeCajaReport();
    const wb = cajaReportToWorkbook(report);
    const bytes = workbookToBytes(wb);

    // XLSX files are ZIP archives; magic bytes are 0x50 0x4B
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
  });
});

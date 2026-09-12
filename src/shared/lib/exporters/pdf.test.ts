/**
 * Unit tests for PDF document builders (src/shared/lib/exporters/pdf.tsx)
 *
 * @react-pdf/renderer runs in a Node-like environment. In jsdom the `pdf()`
 * function calls `.toBlob()` which returns a Web Blob. We mock the underlying
 * `@react-pdf/renderer` module so tests are fast and deterministic, and we test
 * the public surface (the async functions resolve to Uint8Array with PDF bytes).
 */

import { describe, expect, it, vi } from 'vitest';
import type { CajaReport, ProductSalesRow } from '@shared/lib/domain';

// ---------------------------------------------------------------------------
// Mock @react-pdf/renderer so tests are deterministic and fast.
// The real renderer uses pdfkit which has stream APIs incompatible with jsdom.
// We return a minimal valid PDF blob (the string "%PDF-" is the magic header).
// IMPORTANT: vi.mock factories are hoisted — no top-level variables may be
// referenced inside them. All values must be inline literals.
// ---------------------------------------------------------------------------

vi.mock('@react-pdf/renderer', () => {
  // Inline: '%PDF-1.4 mock\n%%EOF\n' encoded as bytes — no external variable refs
  const pdfMagicStr = '%PDF-1.4 mock\n%%EOF\n';
  const pdfBytes = new TextEncoder().encode(pdfMagicStr);
  const mockBlob = new Blob([pdfBytes], { type: 'application/pdf' });

  return {
    Document: (props: { children: unknown }) => props.children,
    Page: (props: { children: unknown }) => props.children,
    View: (props: { children: unknown }) => props.children,
    Text: (props: { children: unknown }) => props.children,
    StyleSheet: {
      create: <T extends object>(styles: T) => styles,
    },
    pdf: () => ({
      toBlob: () => Promise.resolve(mockBlob),
    }),
  };
});

// Import after mocks are hoisted
import { cajaReportToPdfBytes, productSalesToPdfBytes } from './pdf';

// ============================================================================
// Fixture factories
// ============================================================================

function makeCajaReport(): CajaReport {
  return {
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
      totalRevenue: 1200,
      cashSales: 700,
      cardSales: 400,
      rappiSales: 100,
      uberEatsSales: 0,
      bankTransferSales: 0,
      bankTransferPending: 0,
      orderCount: 20,
      tabCount: 8,
      totalExpenses: 100,
      totalIncome: 50,
      netBalance: 1150,
    },
    cashReconciliation: {
      openingCash: 500,
      cashSales: 700,
      expectedCash: 1200,
      closingCash: null,
      variance: null,
    },
    topProducts: [{ productName: 'Corona', quantity: 10, revenue: 300 }],
    staffSummary: [
      {
        staffId: '00000000-0000-0000-0000-000000000003',
        staffName: 'Alex',
        orderCount: 20,
        salesTotal: 1200,
      },
    ],
    cajaEntries: [],
  };
}

/** Variant of {@link makeCajaReport} whose topProducts span two categories (D-03 grouping). */
function makeCajaReportWithCategories(): CajaReport {
  const report = makeCajaReport();
  return {
    ...report,
    topProducts: [
      {
        productName: 'Corona',
        quantity: 10,
        revenue: 300,
        categoryId: '00000000-0000-0000-0000-000000000010',
        categoryName: 'Cervezas',
      },
      {
        productName: 'Hot Dog',
        quantity: 5,
        revenue: 145,
        categoryId: '00000000-0000-0000-0000-000000000011',
        categoryName: 'Comida',
      },
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('cajaReportToPdfBytes', () => {
  it('resolves to non-empty Uint8Array', async () => {
    const report = makeCajaReport();
    const bytes = await cajaReportToPdfBytes(report);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('first bytes are %PDF (PDF magic bytes)', async () => {
    const report = makeCajaReport();
    const bytes = await cajaReportToPdfBytes(report);

    // Decode the first 4 bytes as ASCII text
    const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    expect(magic).toBe('%PDF');
  });

  it('resolves to PDF bytes when topProducts span two categories', async () => {
    const report = makeCajaReportWithCategories();
    const bytes = await cajaReportToPdfBytes(report);

    const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    expect(magic).toBe('%PDF');
  });
});

describe('productSalesToPdfBytes', () => {
  it('resolves without throwing for empty rows array', async () => {
    const rows: ProductSalesRow[] = [];
    const dateRange = { from: new Date('2024-01-01'), to: new Date('2024-01-31') };

    const bytes = await productSalesToPdfBytes(rows, dateRange);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('resolves without throwing for multiple rows', async () => {
    const rows: ProductSalesRow[] = [
      {
        productId: 'p1',
        productName: 'Corona',
        categoryName: 'Beer',
        units: 10,
        revenue: 300,
        costTotal: 180,
        margin: 120,
        marginPct: 40,
        pctTotal: 75,
      },
      {
        productId: 'p2',
        productName: 'Modelo',
        categoryName: 'Beer',
        units: 3,
        revenue: 100,
        costTotal: 60,
        margin: 40,
        marginPct: 40,
        pctTotal: 25,
      },
    ];
    const dateRange = { from: new Date('2024-03-01'), to: new Date('2024-03-31') };

    const bytes = await productSalesToPdfBytes(rows, dateRange);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

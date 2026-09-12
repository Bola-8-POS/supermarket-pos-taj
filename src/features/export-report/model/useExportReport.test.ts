/**
 * Unit tests for useExportReport hook (src/features/export-report/model/useExportReport.ts)
 *
 * Mocks:
 * - @tauri-apps/plugin-dialog (save dialog)
 * - @tauri-apps/plugin-fs (writeFile)
 * - @shared/lib/exporters/excel (workbook builders — pure, fast)
 * - @shared/lib/exporters/pdf.tsx (async PDF builders — avoid slow rendering)
 * - sonner (toast)
 * - @shared/lib/logger-instance (suppress logs in tests)
 */

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CajaReport } from '@shared/lib/domain';

// ---------------------------------------------------------------------------
// Tauri plugin mocks (must appear before the module import)
// ---------------------------------------------------------------------------

const mockSave = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (args: unknown) => mockSave(args) as Promise<string | null>,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (path: unknown, data: unknown) => mockWriteFile(path, data) as Promise<void>,
}));

// ---------------------------------------------------------------------------
// Exporter mocks — return minimal byte arrays so we don't run XLSX/PDF logic
// ---------------------------------------------------------------------------

const MOCK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK zip magic

vi.mock('@shared/lib/exporters/excel', () => ({
  cajaReportToWorkbook: vi.fn(() => ({})),
  productSalesToWorkbook: vi.fn(() => ({})),
  hourlySalesToWorkbook: vi.fn(() => ({})),
  workbookToBytes: vi.fn(() => MOCK_BYTES),
}));

vi.mock('@shared/lib/exporters/pdf.tsx', () => ({
  cajaReportToPdfBytes: vi.fn(() => Promise.resolve(MOCK_BYTES)),
  productSalesToPdfBytes: vi.fn(() => Promise.resolve(MOCK_BYTES)),
  hourlySalesToPdfBytes: vi.fn(() => Promise.resolve(MOCK_BYTES)),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import hook after mocks are hoisted
// ---------------------------------------------------------------------------
import { useExportReport } from './useExportReport';

// ============================================================================
// Fixture
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
      totalRevenue: 1000,
      cashSales: 600,
      cardSales: 300,
      rappiSales: 100,
      uberEatsSales: 0,
      bankTransferSales: 0,
      bankTransferPending: 0,
      orderCount: 15,
      tabCount: 6,
      totalExpenses: 0,
      totalIncome: 0,
      netBalance: 1000,
    },
    cashReconciliation: {
      openingCash: 500,
      cashSales: 600,
      expectedCash: 1100,
      closingCash: null,
      variance: null,
    },
    topProducts: [],
    staffSummary: [],
    cajaEntries: [],
  };
}

const MOCK_PATH = '/tmp/report-2024-03-15.xlsx';

// ============================================================================
// Tests
// ============================================================================

describe('useExportReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls dialog.save with .xlsx extension for excel type', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useExportReport());

    await act(async () => {
      await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(mockSave).toHaveBeenCalledOnce();
    // vi.fn() calls are untyped — access via the first positional arg recorded by the mock
    const saveArgs = mockSave.mock.lastCall?.[0] as
      | { defaultPath?: string; filters?: Array<{ extensions: string[] }> }
      | undefined;
    expect(saveArgs?.defaultPath).toMatch(/\.xlsx$/);
    expect(saveArgs?.filters?.[0]?.extensions).toContain('xlsx');
  });

  it('calls dialog.save with .pdf extension for pdf type', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH.replace('.xlsx', '.pdf'));
    mockWriteFile.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useExportReport());

    await act(async () => {
      await result.current.exportReport('caja-pdf', makeCajaReport());
    });

    expect(mockSave).toHaveBeenCalledOnce();
    const saveArgs = mockSave.mock.lastCall?.[0] as
      | { defaultPath?: string; filters?: Array<{ extensions: string[] }> }
      | undefined;
    expect(saveArgs?.defaultPath).toMatch(/\.pdf$/);
    expect(saveArgs?.filters?.[0]?.extensions).toContain('pdf');
  });

  it('calls fs.writeFile with the path returned by dialog.save', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useExportReport());

    await act(async () => {
      await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [writePath, writeData] = mockWriteFile.mock.lastCall as [string, Uint8Array];
    expect(writePath).toBe(MOCK_PATH);
    expect(writeData).toBeInstanceOf(Uint8Array);
  });

  it('returns ok(undefined) on success', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useExportReport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportReport>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(exportResult?.ok).toBe(true);
  });

  it('returns err(EXPORT_CANCELLED) when dialog.save returns null', async () => {
    mockSave.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useExportReport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportReport>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(exportResult?.ok).toBe(false);
    if (exportResult && !exportResult.ok) {
      expect(exportResult.error.code).toBe('EXPORT_CANCELLED');
    }
  });

  it('returns err(EXPORT_FAILED) when fs.writeFile throws', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH);
    mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

    const { result } = renderHook(() => useExportReport());

    let exportResult: Awaited<ReturnType<typeof result.current.exportReport>> | undefined;
    await act(async () => {
      exportResult = await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(exportResult?.ok).toBe(false);
    if (exportResult && !exportResult.ok) {
      expect(exportResult.error.code).toBe('EXPORT_FAILED');
    }
  });

  it('does not call fs.writeFile if dialog returns null', async () => {
    mockSave.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useExportReport());

    await act(async () => {
      await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('isExporting is false after export completes', async () => {
    mockSave.mockResolvedValueOnce(MOCK_PATH);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useExportReport());

    await act(async () => {
      await result.current.exportReport('caja-excel', makeCajaReport());
    });

    expect(result.current.isExporting).toBe(false);
  });
});

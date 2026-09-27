import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptSettingsSchema, type ReceiptSettings } from './domain';
import type { ReceiptData } from './edge-function-contracts';
import {
  openCashDrawer,
  printJobErrorCopyKey,
  printRawText,
  printReceipt,
  receiptDataToPrinterLines,
  testPrint,
} from './pos-printer';

// Vitest hoists vi.mock factories above other imports — factory body kept
// free of outer-scope references (asserted on via `toast` imported above).
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

function defaultReceiptSettings(overrides?: Partial<ReceiptSettings>): ReceiptSettings {
  return ReceiptSettingsSchema.parse({ ...overrides });
}

function sampleReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    receiptNumber: 'R1',
    tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    customerName: 'Guest',
    cashierName: 'Staff',
    storeName: 'Bar',
    barAddress: '1 St',
    items: [{ name: 'Item', quantity: 1, unitPrice: 5, lineTotal: 5 }],
    subtotal: 5,
    total: 5,
    paymentMethod: 'cash',
    processedAt: new Date('2026-04-17T10:00:00.000Z'),
    squareReceiptUrl: null,
    tenderedAmount: 10,
    changeAmount: 5,
    ...overrides,
  };
}

describe('printJobErrorCopyKey', () => {
  it('maps PRINT_BROKER_UNREACHABLE to the brokerUnreachable copy key', () => {
    expect(printJobErrorCopyKey('PRINT_BROKER_UNREACHABLE')).toBe(
      'common:printJobError.brokerUnreachable'
    );
  });

  it('maps PRINT_JOB_REJECTED to the rejected copy key', () => {
    expect(printJobErrorCopyKey('PRINT_JOB_REJECTED')).toBe('common:printJobError.rejected');
  });

  it('maps PRINT_JOB_UNKNOWN and any other unmapped code to the failed fallback copy key', () => {
    expect(printJobErrorCopyKey('PRINT_JOB_UNKNOWN')).toBe('common:printJobError.failed');
    expect(printJobErrorCopyKey('NETWORK_OFFLINE')).toBe('common:printJobError.failed');
  });
});

describe('receiptDataToPrinterLines', () => {
  it('builds fully-translated lines (locale-resolved) for Rust print_receipt', () => {
    const data = sampleReceipt();
    const lines = receiptDataToPrinterLines(data, defaultReceiptSettings());
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.join('\n')).toContain('Bar');
    expect(lines.some(l => l.includes('R1') || l.includes('#'))).toBe(true);
  });

  it('coerces processedAt from ISO string without throwing', () => {
    const lines = receiptDataToPrinterLines(
      sampleReceipt({
        processedAt: '2026-06-01T15:30:00.000Z' as unknown as Date,
      }),
      defaultReceiptSettings()
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('handles null optional amounts (card payment, no tender)', () => {
    const lines = receiptDataToPrinterLines(
      sampleReceipt({
        paymentMethod: 'card',
        tenderedAmount: null,
        changeAmount: null,
        terminalReference: undefined,
      }),
      defaultReceiptSettings()
    );
    expect(lines.some(l => l.includes('Tendered'))).toBe(false);
  });
});

describe('printReceipt', () => {
  const originalOpen = window.open;
  const originalAlert = window.alert;

  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ job_id: 'mock-receipt-job', status: 'accepted' });
    vi.mocked(toast.loading).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    window.open = originalOpen;
    window.alert = originalAlert;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('uses web fallback when not Tauri and window.open succeeds', async () => {
    const write = vi.fn();
    const close = vi.fn();
    window.open = vi.fn().mockReturnValue({
      document: { write, close },
    });

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('returns ok when popup blocked in web fallback', async () => {
    window.open = vi.fn().mockReturnValue(null);

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());
    expect(result.ok).toBe(true);
  });

  it('invokes print_receipt in Tauri and returns the broker job id (PRN-02)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobId).toBe('mock-receipt-job');
    }
    expect(invoke).toHaveBeenCalledWith(
      'print_receipt',
      expect.objectContaining({ lines: expect.any(Array) })
    );
  });

  it('sends logoDataUrl and paperWidthChars from settings on the Tauri invoke (RCPD-02)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printReceipt(
      sampleReceipt(),
      defaultReceiptSettings({ logoDataUrl: 'data:image/png;base64,AAAA' })
    );
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'print_receipt',
      expect.objectContaining({ logoDataUrl: 'data:image/png;base64,AAAA', paperWidthChars: 32 })
    );
  });

  it('maps a non-broker invoke failure to PRINT_JOB_REJECTED after retries', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('Printer offline'));

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_JOB_REJECTED');
      expect(result.error.message).toContain('Printer offline');
    }
  });

  it('maps a "broker unreachable" invoke failure to PRINT_BROKER_UNREACHABLE after retries (D-12)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('broker unreachable: connection refused'));

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_BROKER_UNREACHABLE');
    }
  });

  it('retries print_receipt up to 3 times before failing (RCP-04)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('Printer offline'));

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());

    expect(result.ok).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(toast.loading).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('succeeds after a transient failure on attempt 2', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce({ job_id: 'mock-receipt-job-2', status: 'accepted' });

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobId).toBe('mock-receipt-job-2');
    }
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(toast.loading).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('stays silent on an immediate first-attempt success', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printReceipt(sampleReceipt(), defaultReceiptSettings());

    expect(result.ok).toBe(true);
    expect(toast.loading).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('openCashDrawer', () => {
  const originalAlert = window.alert;

  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ job_id: 'mock-drawer-job', status: 'accepted' });
    window.alert = vi.fn();
  });

  afterEach(() => {
    window.alert = originalAlert;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('shows alert and returns ok when not Tauri', async () => {
    const result = await openCashDrawer();
    expect(result.ok).toBe(true);
    expect(window.alert).toHaveBeenCalledWith(
      'Cash drawer is only available when the POS runs in the desktop app (Tauri).'
    );
  });

  it('invokes open_cash_drawer in Tauri and returns the broker job id (PRN-02)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    const result = await openCashDrawer();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobId).toBe('mock-drawer-job');
    }
    expect(invoke).toHaveBeenCalledWith('open_cash_drawer', { printerName: undefined });
  });

  it('maps a non-broker invoke failure to PRINT_JOB_REJECTED', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('drawer jam'));

    const result = await openCashDrawer();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_JOB_REJECTED');
    }
  });

  it('maps a "broker unreachable" invoke failure to PRINT_BROKER_UNREACHABLE (D-12)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('broker unreachable: connection refused'));

    const result = await openCashDrawer();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_BROKER_UNREACHABLE');
    }
  });
});

describe('testPrint', () => {
  const originalAlert = window.alert;

  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ job_id: 'mock-job-1', status: 'accepted' });
    window.alert = vi.fn();
  });

  afterEach(() => {
    window.alert = originalAlert;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('returns err when not in Tauri', async () => {
    const result = await testPrint();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('desktop app');
    }
    expect(window.alert).toHaveBeenCalled();
  });

  it('invokes test_print in Tauri and returns the broker job id (PRN-02)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    const result = await testPrint();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobId).toBe('mock-job-1');
    }
    expect(invoke).toHaveBeenCalledWith('test_print', { printerName: undefined });
  });

  it('maps a "broker unreachable" failure to PRINT_BROKER_UNREACHABLE (D-12)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('broker unreachable: connection refused'));

    const result = await testPrint();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_BROKER_UNREACHABLE');
    }
  });

  it('maps any other submission failure to PRINT_JOB_REJECTED', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('broker rejected job: HTTP 400'));

    const result = await testPrint();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_JOB_REJECTED');
    }
  });
});

// ---------------------------------------------------------------------------
// printRawText — autoCut AC coverage (AC 1, 2)
// ---------------------------------------------------------------------------

describe('printRawText', () => {
  const originalOpen = window.open;

  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ job_id: 'mock-raw-text-job', status: 'accepted' });
    // Silence browser fallback popup in non-Tauri path
    window.open = vi.fn().mockReturnValue(null);
  });

  afterEach(() => {
    window.open = originalOpen;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('appends ESC/POS cut bytes when autoCut is true (AC-1)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printRawText('hello', { autoCut: true, printerName: undefined });

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('print_raw_text', {
      text: 'hello\x1d\x56\x41\x00',
    });
  });

  it('does NOT append cut bytes when autoCut is false (AC-2)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printRawText('hello', { autoCut: false, printerName: undefined });

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('print_raw_text', { text: 'hello' });
  });

  it('does NOT append cut bytes when options are omitted (AC-2)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printRawText('hello');

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('print_raw_text', { text: 'hello' });
  });

  it('invokes print_raw_text in Tauri and returns the broker job id (PRN-02)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const result = await printRawText('hello');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.jobId).toBe('mock-raw-text-job');
    }
  });

  it('maps a non-broker invoke failure to PRINT_JOB_REJECTED', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('Paper jam'));

    const result = await printRawText('hello', { autoCut: true, printerName: undefined });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_JOB_REJECTED');
      expect(result.error.message).toContain('Paper jam');
    }
  });

  it('maps a "broker unreachable" invoke failure to PRINT_BROKER_UNREACHABLE (D-12)', async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(new Error('broker unreachable: connection refused'));

    const result = await printRawText('hello');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINT_BROKER_UNREACHABLE');
    }
  });
});

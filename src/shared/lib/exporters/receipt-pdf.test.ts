/**
 * Unit tests for receipt-pdf.tsx (src/shared/lib/exporters/receipt-pdf.tsx)
 *
 * Mirrors pdf.test.ts's `vi.mock('@react-pdf/renderer', ...)` factory (a
 * minimal `%PDF-` magic-header blob so tests are fast/deterministic), but
 * ALSO captures the `doc` element tree the mocked `pdf()` receives into a
 * module-scoped variable so this file can directly assert the embedded
 * `<Text>` node's children equal buildThermalReceiptText's exact output
 * (D-05 — never a re-derived/re-formatted string).
 *
 * Also mirrors useExportReport.test.ts's `@tauri-apps/plugin-dialog` /
 * `@tauri-apps/plugin-fs` mocks for downloadReceiptPdf's save-dialog flow.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptSettingsSchema, type ReceiptSettings } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';

// ---------------------------------------------------------------------------
// Mock @react-pdf/renderer — capture the `doc` element tree passed to pdf()
// so tests can walk Document -> Page -> Text and assert on the exact text.
// vi.mock factories are hoisted — no top-level variable references inside them.
// ---------------------------------------------------------------------------

vi.mock('@react-pdf/renderer', () => {
  const pdfMagicStr = '%PDF-1.4 mock\n%%EOF\n';
  const pdfBytes = new TextEncoder().encode(pdfMagicStr);
  const mockBlob = new Blob([pdfBytes], { type: 'application/pdf' });

  const DocumentMock = (props: { children: unknown }) => props.children;
  const PageMock = (props: { children: unknown }) => props.children;
  const TextMock = (props: { children: unknown }) => props.children;

  // The doc passed to pdf() is `<ReceiptDoc text={...} />` — an unrendered
  // custom-component element wrapping Document/Page/Text, since
  // receipt-pdf.tsx (mirroring pdf.tsx's pattern) never renders it itself.
  // Shallow-resolve any function-component layer that ISN'T Document/Page/Text
  // (i.e. ReceiptDoc) so the captured tree bottoms out at the real
  // Document -> Page -> Text chain this test walks.
  type ElementLike = { type: unknown; props: unknown };

  function resolveElement(el: unknown): unknown {
    if (el !== null && typeof el === 'object' && 'type' in el && 'props' in el) {
      const { type, props } = el as ElementLike;
      if (typeof type === 'function' && type !== DocumentMock && type !== PageMock && type !== TextMock) {
        const componentFn = type as (p: unknown) => unknown;
        return resolveElement(componentFn(props));
      }
    }
    return el;
  }

  return {
    Document: DocumentMock,
    Page: PageMock,
    Text: TextMock,
    StyleSheet: {
      create: <T extends object>(styles: T) => styles,
    },
    pdf: (doc: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- test capture only
      (globalThis as unknown as { __capturedDoc: unknown }).__capturedDoc = resolveElement(doc);
      return { toBlob: () => Promise.resolve(mockBlob) };
    },
  };
});

// ---------------------------------------------------------------------------
// Mock @tauri-apps/plugin-dialog / @tauri-apps/plugin-fs (useExportReport.test.ts shape)
// ---------------------------------------------------------------------------

const mockSave = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (args: unknown) => mockSave(args) as Promise<string | null>,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (path: unknown, data: unknown) => mockWriteFile(path, data) as Promise<void>,
}));

// Import after mocks are hoisted
import { getCurrentLocale } from '@shared/lib/i18n';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import {
  downloadReceiptPdf,
  receiptToPdfBytes,
  uint8ArrayToBase64,
} from './receipt-pdf';

function getCapturedDoc(): unknown {
  return (globalThis as unknown as { __capturedDoc: unknown }).__capturedDoc;
}

/** Walks the mocked Document -> Page -> Text element tree captured by pdf(). */
function extractTextChildren(doc: unknown): unknown {
  const documentEl = doc as { props: { children: unknown } };
  const pageEl = documentEl.props.children as { props: { children: unknown } };
  const textEl = pageEl.props.children as { props: { children: unknown } };
  return textEl.props.children;
}

function makeReceipt(overrides?: Partial<ReceiptData>): ReceiptData {
  return {
    receiptNumber: 'R1',
    tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customerName: 'Guest',
    cashierName: 'Staff',
    storeName: 'Store',
    barAddress: '',
    items: [],
    subtotal: 1,
    total: 1,
    paymentMethod: 'cash',
    processedAt: new Date('2026-08-24T12:00:00Z'),
    squareReceiptUrl: null,
    tenderedAmount: 5,
    changeAmount: 4,
    ...overrides,
  };
}

function defaultSettings(overrides?: Partial<ReceiptSettings>): ReceiptSettings {
  return ReceiptSettingsSchema.parse({ ...overrides });
}

describe('receiptToPdfBytes', () => {
  beforeEach(() => {
    (globalThis as unknown as { __capturedDoc: unknown }).__capturedDoc = null;
  });

  it('resolves to a non-empty Uint8Array', async () => {
    const receipt = makeReceipt();
    const settings = defaultSettings();

    const bytes = await receiptToPdfBytes(receipt, settings);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('embeds a single Text node whose children is buildThermalReceiptText output verbatim', async () => {
    const receipt = makeReceipt();
    const settings = defaultSettings();

    await receiptToPdfBytes(receipt, settings);

    const doc = getCapturedDoc();
    expect(doc).not.toBeNull();
    const embeddedText = extractTextChildren(doc);
    const expectedText = buildThermalReceiptText(receipt, getCurrentLocale(), settings);
    expect(embeddedText).toBe(expectedText);
  });
});

describe('uint8ArrayToBase64', () => {
  it('base64-encodes bytes correctly (including a chunk-boundary-sized array)', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(uint8ArrayToBase64(bytes)).toBe(btoa('Hello'));
  });

  it('handles arrays larger than the internal chunk size without stack overflow', () => {
    const bytes = new Uint8Array(20_000).fill(65); // 20,000 x 'A'
    const result = uint8ArrayToBase64(bytes);
    expect(result.length).toBeGreaterThan(0);
    expect(atob(result).length).toBe(20_000);
  });
});

describe('downloadReceiptPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the generated PDF bytes via the Tauri save dialog + writeFile', async () => {
    mockSave.mockResolvedValue('/tmp/receipt-R1.pdf');
    mockWriteFile.mockResolvedValue(undefined);

    const receipt = makeReceipt();
    const settings = defaultSettings();

    const result = await downloadReceiptPdf(receipt, settings);

    expect(result.ok).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'receipt-R1.pdf' })
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/receipt-R1.pdf',
      expect.any(Uint8Array)
    );
  });

  it('returns EXPORT_CANCELLED without calling writeFile when the user cancels the save dialog', async () => {
    mockSave.mockResolvedValue(null);

    const receipt = makeReceipt();
    const settings = defaultSettings();

    const result = await downloadReceiptPdf(receipt, settings);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXPORT_CANCELLED');
    }
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('returns EXPORT_FAILED when a Tauri call throws', async () => {
    mockSave.mockRejectedValue(new Error('dialog crashed'));

    const receipt = makeReceipt();
    const settings = defaultSettings();

    const result = await downloadReceiptPdf(receipt, settings);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXPORT_FAILED');
    }
  });
});

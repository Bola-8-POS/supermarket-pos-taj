import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptSettingsSchema, type ReceiptSettings } from './domain';
import * as contracts from './edge-function-contracts';
import { sendReceiptByEmail } from './email-receipt';
import * as receiptPdf from './exporters/receipt-pdf';
import * as receiptFormat from './receipt-format';
import { ok } from './result';

function defaultReceiptSettings(overrides?: Partial<ReceiptSettings>): ReceiptSettings {
  return ReceiptSettingsSchema.parse({ ...overrides });
}

describe('sendReceiptByEmail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const receipt = {
    receiptNumber: 'R1',
    tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    customerName: 'Guest',
    cashierName: 'Staff',
    storeName: 'Bar',
    barAddress: '',
    items: [],
    subtotal: 1,
    total: 1,
    paymentMethod: 'cash' as const,
    processedAt: new Date(),
    squareReceiptUrl: null,
    tenderedAmount: 5,
    changeAmount: 4,
  };

  it('returns validation error for bad email without calling edge', async () => {
    const spy = vi.spyOn(contracts, 'callSendReceiptEmail');

    const result = await sendReceiptByEmail(receipt, 'not-email', defaultReceiptSettings());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls edge with trimmed email, thermal plain text, and a base64 PDF attachment', async () => {
    const spy = vi.spyOn(contracts, 'callSendReceiptEmail').mockResolvedValue(ok(undefined));
    const buildSpy = vi.spyOn(receiptFormat, 'buildThermalReceiptText').mockReturnValue('PLAIN\n');
    vi.spyOn(receiptPdf, 'receiptToPdfBytes').mockResolvedValue(new Uint8Array([1, 2, 3]));

    const result = await sendReceiptByEmail(receipt, '  a@b.co  ', defaultReceiptSettings());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ pdfAttached: true });
    }
    expect(buildSpy).toHaveBeenCalledWith(receipt, expect.any(String), expect.any(Object), {
      demoWatermark: false,
    });
    expect(spy).toHaveBeenCalledWith({
      email: 'a@b.co',
      receiptPlainText: 'PLAIN\n',
      pdfBase64: expect.any(String),
    });
  });

  it('still sends the email without a PDF attachment when PDF generation throws', async () => {
    const spy = vi.spyOn(contracts, 'callSendReceiptEmail').mockResolvedValue(ok(undefined));
    vi.spyOn(receiptFormat, 'buildThermalReceiptText').mockReturnValue('PLAIN\n');
    vi.spyOn(receiptPdf, 'receiptToPdfBytes').mockRejectedValue(new Error('renderer crashed'));

    const result = await sendReceiptByEmail(receipt, 'a@b.co', defaultReceiptSettings());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ pdfAttached: false });
    }
    expect(spy).toHaveBeenCalledWith({
      email: 'a@b.co',
      receiptPlainText: 'PLAIN\n',
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSale } from './offline-sale.fixtures';
import { buildProvisionalReceipt, provisionalReceiptNumber } from './provisional-receipt';

const STORE = { storeName: 'Bola 8 Cantina', address: 'Av. Insurgentes 123' };

afterEach(() => {
  vi.useRealTimers();
});

describe('buildProvisionalReceipt', () => {
  it('builder copies items, subtotal, total, tender, change and card reference from the record', () => {
    const cash = buildProvisionalReceipt(makeSale(), STORE);
    expect(cash).toMatchObject({
      provisional: true,
      storeName: 'Bola 8 Cantina',
      barAddress: 'Av. Insurgentes 123',
      cashierName: 'Sofia',
      paymentMethod: 'cash',
      subtotal: 9,
      total: 9,
      tenderedAmount: 10,
      changeAmount: 1,
      items: [
        {
          name: 'Basmati rice 1kg',
          quantity: 2,
          unitPrice: 4.5,
          lineTotal: 9,
          categoryName: 'Rice',
        },
      ],
    });
    // the tax breakdown and the server tab are not claimed
    expect(cash).not.toHaveProperty('taxAmount');
    expect(cash.tabId).toBe(makeSale().id);

    const sale = makeSale();
    const card = buildProvisionalReceipt(
      makeSale({
        request: {
          ...sale.request,
          method: 'card',
          tenderedAmount: undefined,
          referenceNumber: 'AUTH-77',
        },
      }),
      STORE
    );
    expect(card).toMatchObject({ paymentMethod: 'card', terminalReference: 'AUTH-77' });
    expect(card.changeAmount ?? null).toBeNull();
  });

  it('prices modifiers and weighed lines and lists every leg of a split sale', () => {
    const sale = makeSale();
    const item = sale.request.items[0];
    if (!item) throw new Error('fixture has an item');
    const split = buildProvisionalReceipt(
      makeSale({
        request: {
          ...sale.request,
          items: [{ ...item, modifierPriceDelta: 0.5 }],
          method: undefined,
          amount: undefined,
          tenderedAmount: undefined,
          expectedTotal: 10,
          legs: [
            { method: 'cash', amount: 4, tenderedAmount: 5 },
            { method: 'card', amount: 6, referenceNumber: 'AUTH-1' },
          ],
        },
      }),
      STORE
    );
    expect(split.items[0]?.lineTotal).toBe(10);
    expect(split.paymentMethod).toBe('cash');
    expect(split.tenders).toEqual([
      { method: 'cash', amount: 4, tenderedAmount: 5, changeAmount: 1, terminalReference: null },
      {
        method: 'card',
        amount: 6,
        tenderedAmount: null,
        changeAmount: null,
        terminalReference: 'AUTH-1',
      },
    ]);
  });

  it('falls back to the product id for a line the snapshot does not cover', () => {
    const sale = makeSale({ lines: [] });
    const receipt = buildProvisionalReceipt(sale, STORE);
    expect(receipt.items[0]?.name).toBe(sale.request.items[0]?.productId);
    expect(receipt.items[0]?.categoryName).toBeNull();
  });

  it('receipt number is P- plus six upper-case chars of the provisional id and is stable across calls', () => {
    const id = 'abcdef12-1111-4111-8111-111111111111';
    expect(provisionalReceiptNumber(id)).toBe('P-ABCDEF');
    const sale = makeSale({ id, receiptNumber: provisionalReceiptNumber(id) });
    const first = buildProvisionalReceipt(sale, STORE);
    expect(first.provisionalNumber).toBe('P-ABCDEF');
    expect(first.receiptNumber).toBe('P-ABCDEF');
    expect(buildProvisionalReceipt(sale, STORE)).toEqual(first);
  });

  it('sale time comes from the record not from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const receipt = buildProvisionalReceipt(makeSale(), STORE);
    expect(receipt.processedAt).toEqual(new Date('2026-10-09T10:00:00.000Z'));
  });
});

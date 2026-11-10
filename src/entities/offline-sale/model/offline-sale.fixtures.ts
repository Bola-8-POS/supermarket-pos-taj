/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import type { OfflineSale } from '@shared/lib/offline-sale-schema';

const ID = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';

/** A queued cash sale; override any field. */
export function makeSale(overrides: Partial<OfflineSale> = {}): OfflineSale {
  return {
    id: ID,
    request: {
      items: [
        {
          productId: '33333333-3333-4333-8333-333333333333',
          quantity: 2,
          unitPrice: 4.5,
          modifierIds: [],
          modifierPriceDelta: 0,
        },
      ],
      shiftId: '44444444-4444-4444-8444-444444444444',
      cajaSessionId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'direct_sale_1700000000000_abcd1234',
      method: 'cash',
      amount: 9,
      tenderedAmount: 10,
      expectedTotal: 9,
      terminalId: 'POS-1',
    },
    lines: [
      {
        productId: '33333333-3333-4333-8333-333333333333',
        name: 'Basmati rice 1kg',
        categoryName: 'Rice',
        modifierNames: [],
      },
    ],
    soldAt: '2026-10-09T10:00:00.000Z',
    staffId: STAFF,
    staffName: 'Sofia',
    receiptNumber: 'P-111111',
    status: 'queued',
    attempts: 0,
    integrity: 'abc',
    reRingAttemptKeys: [],
    resolutionOutcomeUnknown: false,
    ...overrides,
  };
}

const uuid = (n: number, k: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-${String(k).padStart(12, '0')}`;

/** The heaviest sale the till stores: 15 modified lines, split cash + card with a reference, full re-ring key list. */
export function makeHeavySale(n: number, soldAtMs: number, overrides: Partial<OfflineSale> = {}): OfflineSale {
  const base = makeSale();
  const items = Array.from({ length: 15 }, (_, k) => ({
    productId: uuid(n, k),
    quantity: 3,
    unitPrice: 12.5,
    modifierIds: [uuid(n, 100 + k)],
    modifierPriceDelta: 1.25,
  }));
  return makeSale({
    id: uuid(n, 999),
    request: {
      ...base.request,
      idempotencyKey: `direct_sale_1700000000000_${String(n).padStart(8, '0')}`,
      items,
      method: undefined,
      amount: undefined,
      tenderedAmount: undefined,
      legs: [
        { method: 'cash', amount: 100, tenderedAmount: 100 },
        { method: 'card', amount: 217.5, referenceNumber: 'R'.repeat(32) },
      ],
      customerName: 'C'.repeat(60),
      customerPhone: '5'.repeat(15),
      discountScope: 'all',
      discountType: 'percent',
      discountValue: 5,
      discountAmount: 16.5,
    },
    lines: items.map(i => ({
      productId: i.productId,
      name: 'Basmati rice premium aged 5kg family pack extra long grain'.slice(0, 60),
      categoryName: 'Rice, flours and grains',
      modifierNames: ['Extra large pack'],
    })),
    soldAt: new Date(soldAtMs).toISOString(),
    staffName: 'Sofia Hernandez Ramirez',
    receiptNumber: `P-${String(n).padStart(6, '0')}`,
    lastMessage: 'm'.repeat(120),
    attempts: 3,
    integrity: 'a'.repeat(64),
    reRingAttemptKeys: Array.from(
      { length: 20 },
      (_, k) => `direct_sale_1700000000000_${String(k).padStart(8, 'a')}`
    ),
    resolutionOutcomeUnknown: false,
    ...overrides,
  });
}

/** A server receipt as large as a real one for the heavy sale: 15 lines, tax breakdown, both tenders, store block. */
export function makeServerReceipt(sale: OfflineSale): NonNullable<OfflineSale['confirmedReceipt']> {
  return {
    receiptNumber: `R-${sale.receiptNumber.slice(2)}`,
    tabId: sale.id,
    customerName: sale.request.customerName ?? 'Walk-in customer',
    cashierName: sale.staffName,
    storeName: 'Bola 8 Supermercado Hindu - Sucursal Centro',
    barAddress: 'Avenida Insurgentes Sur 1234, Colonia Del Valle, Benito Juarez, CDMX, 03100',
    items: sale.request.items.map((item, k) => ({
      name: sale.lines[k]?.name ?? 'Item',
      quantity: item.quantity,
      unitPrice: item.unitPrice + item.modifierPriceDelta,
      lineTotal: (item.unitPrice + item.modifierPriceDelta) * item.quantity,
      categoryId: uuid(0, 500 + k),
      categoryName: sale.lines[k]?.categoryName ?? null,
      modifierNames: sale.lines[k]?.modifierNames ?? [],
      weightGrams: null,
      promotionId: uuid(0, 700 + k),
      discountRate: 5,
      discountAmount: 1.9,
    })),
    subtotal: 317.5,
    total: 301,
    taxAmount: 41.52,
    taxRatePercent: 16,
    taxInclusive: true,
    paymentMethod: 'cash',
    processedAt: new Date('2026-10-09T12:30:00.000Z'),
    squareReceiptUrl: null,
    tenderedAmount: 317.5,
    changeAmount: 16.5,
    terminalReference: 'R'.repeat(32),
    discountAmount: 16.5,
    discountScope: 'all',
    discountType: 'percent',
    discountValue: 5,
    tenders: [
      { method: 'cash', amount: 100, tenderedAmount: 100, changeAmount: 0, terminalReference: null },
      { method: 'card', amount: 201, tenderedAmount: null, changeAmount: null, terminalReference: 'R'.repeat(32) },
    ],
  };
}

/** WebView2 / Chromium localStorage quota per origin, in UTF-16 code units (key + value). */
export const STORAGE_QUOTA_CHARS = 5_242_880;

import type { GeneralSettings } from '@shared/lib/domain';
import type { ReceiptData, ReceiptTender } from '@shared/lib/edge-function-contracts';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';

/** Local receipt number for a sale rung offline: `P-` + first six chars of its provisional id. */
export const provisionalReceiptNumber = (id: string): string => `P-${id.slice(0, 6).toUpperCase()}`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

type Leg = {
  method: ReceiptTender['method'];
  amount: number;
  tenderedAmount: number | null;
  ref: string | null;
};

/**
 * The receipt handed over while the backend is unreachable (Ruling 7). Built
 * only from the stored record, so printing it again before confirmation gives
 * the same page. It carries no tax breakdown and no server receipt number, and
 * `tabId` holds the local sale id because no server tab exists yet.
 */
export function buildProvisionalReceipt(
  record: OfflineSale,
  store: Pick<GeneralSettings, 'storeName' | 'address'>
): ReceiptData {
  const { request } = record;

  const items = request.items.map((item, i) => {
    const line = record.lines[i];
    return {
      name: line?.name ?? item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: round2((item.unitPrice + item.modifierPriceDelta) * item.quantity),
      categoryName: line?.categoryName ?? null,
      modifierNames: line?.modifierNames ?? [],
      weightGrams: item.weightGrams ?? null,
    };
  });
  const subtotal = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));

  const legs: Leg[] = request.legs
    ? request.legs.map(l => ({
        method: l.method,
        amount: l.amount,
        tenderedAmount: l.tenderedAmount ?? null,
        ref: l.referenceNumber ?? null,
      }))
    : request.method
      ? [
          {
            method: request.method,
            amount: request.amount ?? 0,
            tenderedAmount: request.tenderedAmount ?? null,
            ref: request.referenceNumber ?? null,
          },
        ]
      : [];
  const total = request.expectedTotal ?? round2(legs.reduce((sum, l) => sum + l.amount, 0));
  const change = (l: Leg): number | null =>
    l.method === 'cash' && l.tenderedAmount !== null
      ? round2(Math.max(0, l.tenderedAmount - l.amount))
      : null;

  const [first] = legs;
  const tenders: ReceiptTender[] = legs.map(l => ({
    method: l.method,
    amount: l.amount,
    tenderedAmount: l.tenderedAmount,
    changeAmount: change(l),
    terminalReference: l.ref,
  }));

  return {
    receiptNumber: record.receiptNumber,
    provisional: true,
    provisionalNumber: record.receiptNumber,
    tabId: record.id,
    customerName: request.customerName ?? '',
    cashierName: record.staffName,
    storeName: store.storeName,
    barAddress: store.address,
    items,
    subtotal,
    total,
    // whatever the cashier's discounts and promotions took off the lines
    ...(subtotal > total ? { discountAmount: round2(subtotal - total) } : {}),
    paymentMethod: first?.method ?? 'cash',
    processedAt: new Date(record.soldAt),
    squareReceiptUrl: null,
    tenderedAmount: first?.tenderedAmount ?? null,
    changeAmount: first ? change(first) : null,
    terminalReference: first?.ref ?? null,
    ...(legs.length > 1 ? { tenders } : {}),
  };
}

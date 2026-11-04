import { describe, expect, it } from 'vitest';
import { computeSaleIntegrity, verifySaleIntegrity } from './integrity';
import { makeSale } from './offline-sale.fixtures';

async function sealed() {
  const sale = makeSale();
  const integrity = await computeSaleIntegrity(sale.request, sale.soldAt, sale.receiptNumber);
  return { ...sale, integrity };
}

describe('offline sale integrity', () => {
  it('is a stable SHA-256 hex independent of key order', async () => {
    const sale = makeSale();
    const a = await computeSaleIntegrity(sale.request, sale.soldAt, sale.receiptNumber);
    const reordered = Object.fromEntries(
      Object.entries(sale.request).reverse()
    ) as typeof sale.request;
    const b = await computeSaleIntegrity(reordered, sale.soldAt, sale.receiptNumber);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('verifies an untouched record', async () => {
    expect(await verifySaleIntegrity(await sealed())).toBe(true);
  });

  it('integrity detects a changed amount and a changed item', async () => {
    const sale = await sealed();
    expect(await verifySaleIntegrity({ ...sale, request: { ...sale.request, amount: 1 } })).toBe(
      false
    );
    const item = sale.request.items[0];
    if (!item) throw new Error('fixture has an item');
    expect(
      await verifySaleIntegrity({
        ...sale,
        request: { ...sale.request, items: [{ ...item, quantity: 3 }] },
      })
    ).toBe(false);
  });

  it('detects a changed sale time or receipt number', async () => {
    const sale = await sealed();
    expect(await verifySaleIntegrity({ ...sale, soldAt: '2026-10-09T11:00:00.000Z' })).toBe(false);
    expect(await verifySaleIntegrity({ ...sale, receiptNumber: 'P-999999' })).toBe(false);
  });
});

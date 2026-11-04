import { beforeEach, describe, expect, it, vi } from 'vitest';

const evaluate = vi.hoisted(() => vi.fn());
vi.mock('./promotion-pricing', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  evaluateBestPromotion: evaluate,
}));

import { resolveProductPromotion } from './resolve-product-promotion';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const product = { id: 'p1', categoryId: 'c1', basePrice: 4.5, name: 'ignored' };
const settings = {
  nearExpiry: { discountPercent: 15, thresholdDays: 14 },
  general: { timezone: 'America/Mexico_City' },
};
const match = { promotionId: 'x', discountRate: 20, discountAmount: 0.9, discountedUnitPrice: 3.6 };

beforeEach(() => {
  evaluate.mockReset();
  evaluate.mockReturnValue(match);
});

describe('resolveProductPromotion', () => {
  it('delegates to evaluateBestPromotion with the checkout screen arguments', () => {
    const result = resolveProductPromotion(
      product,
      [],
      settings,
      [
        { productId: 'other', expiryDate: '2026-10-10' },
        { productId: 'p1', expiryDate: '2026-10-14' },
      ],
      NOW
    );

    expect(result).toBe(match);
    expect(evaluate).toHaveBeenCalledWith(
      { productId: 'p1', categoryId: 'c1', basePrice: 4.5 },
      [],
      NOW,
      15,
      5,
      14,
      'America/Mexico_City'
    );
  });

  it('passes null days when the product has no near-expiry alert or the alerts are not loaded', () => {
    resolveProductPromotion(product, [], settings, [], NOW);
    resolveProductPromotion(product, [], settings, undefined, NOW);
    expect(evaluate.mock.calls.map(c => c[4])).toEqual([null, null]);
  });
});

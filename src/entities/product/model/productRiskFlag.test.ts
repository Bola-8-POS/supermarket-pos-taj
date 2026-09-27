import { describe, expect, it } from 'vitest';
import { generateMockProduct } from '@shared/lib/mocks';
import { getProductRiskFlag } from './productRiskFlag';

describe('getProductRiskFlag', () => {
  it('flags a zero-price product', () => {
    expect(getProductRiskFlag(generateMockProduct({ basePrice: 0 }))).toBe('zero-price');
  });

  it('does not flag a product with no inventory row (fail-open, Pitfall 2)', () => {
    expect(
      getProductRiskFlag(
        generateMockProduct({ basePrice: 5, quantityOnHand: undefined, lowStockThreshold: undefined })
      )
    ).toBeNull();
  });

  it('flags low-stock at the inclusive boundary (quantityOnHand === lowStockThreshold)', () => {
    expect(
      getProductRiskFlag(
        generateMockProduct({ basePrice: 5, quantityOnHand: 3, lowStockThreshold: 3 })
      )
    ).toBe('low-stock');
  });

  it('does not flag an adequately stocked product', () => {
    expect(
      getProductRiskFlag(
        generateMockProduct({ basePrice: 5, quantityOnHand: 10, lowStockThreshold: 3 })
      )
    ).toBeNull();
  });

  it('prefers zero-price when both conditions are true (single deterministic flag)', () => {
    expect(
      getProductRiskFlag(
        generateMockProduct({ basePrice: 0, quantityOnHand: 1, lowStockThreshold: 5 })
      )
    ).toBe('zero-price');
  });
});

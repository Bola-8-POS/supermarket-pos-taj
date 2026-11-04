import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import type { CartItem, Order } from './domain';
import {
  calculateOrderItemLineTotal,
  calculateTabSubtotal,
  formatElapsed,
  generateIdempotencyKey,
  getDiscountBase,
  calculateDiscountAmount,
} from './domain-helpers';

describe('calculateOrderItemLineTotal', () => {
  const baseCartItem: CartItem = {
    tempId: 'temp-1',
    product: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Beer',
      categoryId: '123e4567-e89b-12d3-a456-426614174001',
      basePrice: 5.0,
      happyHourPrice: null,
      sku: null,
      isActive: true,
      soldByWeight: false,
      imageUrl: null,
      photoPath: null,
      stock_threshold: null,
      unitsPerPackage: null,
      parentProductId: null,
      brandId: null,
      weightAmount: null,
      weightUnit: null,
      comboEligible: true,
      isCombo: false,
      modifiers: [],
    },
    quantity: 1,
    selectedModifiers: [],
    unitPrice: 5.0,
    notes: '',
    lineTotal: 0,
  };

  it('should calculate line total without modifiers', () => {
    const total = calculateOrderItemLineTotal(baseCartItem);
    expect(total).toBe(5.0);
  });

  it('should calculate line total with positive modifier', () => {
    const item: CartItem = {
      ...baseCartItem,
      selectedModifiers: [
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          name: 'Double Shot',
          priceDelta: 2.0,
          sortOrder: 0,
        },
      ],
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(7.0); // (5.00 + 2.00) * 1
  });

  it('should calculate line total with negative modifier', () => {
    const item: CartItem = {
      ...baseCartItem,
      selectedModifiers: [
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          name: 'No Ice',
          priceDelta: -0.5,
          sortOrder: 0,
        },
      ],
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(4.5); // (5.00 - 0.50) * 1
  });

  it('should calculate line total with multiple modifiers', () => {
    const item: CartItem = {
      ...baseCartItem,
      selectedModifiers: [
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          name: 'Double Shot',
          priceDelta: 2.0,
          sortOrder: 0,
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174003',
          name: 'Extra Lime',
          priceDelta: 0.5,
          sortOrder: 1,
        },
      ],
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(7.5); // (5.00 + 2.00 + 0.50) * 1
  });

  it('should calculate line total with quantity', () => {
    const item: CartItem = {
      ...baseCartItem,
      quantity: 3,
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(15.0); // 5.00 * 3
  });

  it('should calculate line total with modifiers and quantity', () => {
    const item: CartItem = {
      ...baseCartItem,
      quantity: 2,
      selectedModifiers: [
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          name: 'Double Shot',
          priceDelta: 2.0,
          sortOrder: 0,
        },
      ],
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(14.0); // (5.00 + 2.00) * 2
  });

  it('should round to 2 decimal places', () => {
    const item: CartItem = {
      ...baseCartItem,
      unitPrice: 5.555,
      quantity: 3,
    };
    const total = calculateOrderItemLineTotal(item);
    expect(total).toBe(16.67); // 5.555 * 3 = 16.665 â†’ 16.67
  });
});

describe('calculateTabSubtotal', () => {
  it('should calculate subtotal with no orders', () => {
    const subtotal = calculateTabSubtotal([]);
    expect(subtotal).toBe(0);
  });

  it('should calculate subtotal with orders only', () => {
    const orders: Order[] = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        tabId: '123e4567-e89b-12d3-a456-426614174001',
        staffId: '123e4567-e89b-12d3-a456-426614174002',
        createdAt: new Date(),
        status: 'pending',
        notes: null,
        items: [
          {
            id: '123e4567-e89b-12d3-a456-426614174003',
            orderId: '123e4567-e89b-12d3-a456-426614174000',
            productId: '123e4567-e89b-12d3-a456-426614174004',
            quantity: 1,
            unitPrice: 10.0,
            modifierIds: [],
            modifierPriceDelta: 0,
            notes: null,
            modifiers: [],
            lineTotal: 10.0,
          },
          {
            id: '123e4567-e89b-12d3-a456-426614174005',
            orderId: '123e4567-e89b-12d3-a456-426614174000',
            productId: '123e4567-e89b-12d3-a456-426614174006',
            quantity: 1,
            unitPrice: 5.5,
            modifierIds: [],
            modifierPriceDelta: 0,
            notes: null,
            modifiers: [],
            lineTotal: 5.5,
          },
        ],
      },
    ];
    const subtotal = calculateTabSubtotal(orders);
    expect(subtotal).toBe(15.5);
  });

  it('should handle multiple orders', () => {
    const orders: Order[] = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        tabId: '123e4567-e89b-12d3-a456-426614174001',
        staffId: '123e4567-e89b-12d3-a456-426614174002',
        createdAt: new Date(),
        status: 'pending',
        notes: null,
        items: [
          {
            id: '123e4567-e89b-12d3-a456-426614174003',
            orderId: '123e4567-e89b-12d3-a456-426614174000',
            productId: '123e4567-e89b-12d3-a456-426614174004',
            quantity: 1,
            unitPrice: 10.0,
            modifierIds: [],
            modifierPriceDelta: 0,
            notes: null,
            modifiers: [],
            lineTotal: 10.0,
          },
        ],
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174005',
        tabId: '123e4567-e89b-12d3-a456-426614174001',
        staffId: '123e4567-e89b-12d3-a456-426614174002',
        createdAt: new Date(),
        status: 'pending',
        notes: null,
        items: [
          {
            id: '123e4567-e89b-12d3-a456-426614174006',
            orderId: '123e4567-e89b-12d3-a456-426614174005',
            productId: '123e4567-e89b-12d3-a456-426614174007',
            quantity: 1,
            unitPrice: 8.0,
            modifierIds: [],
            modifierPriceDelta: 0,
            notes: null,
            modifiers: [],
            lineTotal: 8.0,
          },
        ],
      },
    ];
    const subtotal = calculateTabSubtotal(orders);
    expect(subtotal).toBe(18.0);
  });

  it('should round to 2 decimal places', () => {
    const orders: Order[] = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        tabId: '123e4567-e89b-12d3-a456-426614174001',
        staffId: '123e4567-e89b-12d3-a456-426614174002',
        createdAt: new Date(),
        status: 'pending',
        notes: null,
        items: [
          {
            id: '123e4567-e89b-12d3-a456-426614174003',
            orderId: '123e4567-e89b-12d3-a456-426614174000',
            productId: '123e4567-e89b-12d3-a456-426614174004',
            quantity: 1,
            unitPrice: 10.555,
            modifierIds: [],
            modifierPriceDelta: 0,
            notes: null,
            modifiers: [],
            lineTotal: 10.555,
          },
        ],
      },
    ];
    const subtotal = calculateTabSubtotal(orders);
    expect(subtotal).toBe(10.56);
  });
});

describe('formatElapsed', () => {
  it('should format seconds only', () => {
    expect(formatElapsed(45)).toBe('00:45');
  });

  it('should format minutes and seconds', () => {
    expect(formatElapsed(90)).toBe('01:30');
  });

  it('should format exactly 1 hour', () => {
    expect(formatElapsed(3600)).toBe('1:00:00');
  });

  it('should format hours, minutes, and seconds', () => {
    expect(formatElapsed(3661)).toBe('1:01:01');
  });

  it('should pad minutes and seconds in hour format', () => {
    expect(formatElapsed(3605)).toBe('1:00:05');
  });

  it('should handle zero', () => {
    expect(formatElapsed(0)).toBe('00:00');
  });

  it('should handle large durations', () => {
    expect(formatElapsed(7200)).toBe('2:00:00');
  });

  it('should format 59 minutes 59 seconds', () => {
    expect(formatElapsed(3599)).toBe('59:59');
  });
});

describe('generateIdempotencyKey', () => {
  it('should generate key with correct format', () => {
    const key = generateIdempotencyKey('payment');
    expect(key).toMatch(/^payment_\d+_[a-f0-9]{8}$/);
  });

  it('should generate unique keys', () => {
    const key1 = generateIdempotencyKey('payment');
    const key2 = generateIdempotencyKey('payment');
    expect(key1).not.toBe(key2);
  });

  it('should include prefix', () => {
    const key = generateIdempotencyKey('refund');
    expect(key).toMatch(/^refund_/);
  });

  it('should handle different prefixes', () => {
    const paymentKey = generateIdempotencyKey('payment');
    const refundKey = generateIdempotencyKey('refund');
    expect(paymentKey.startsWith('payment_')).toBe(true);
    expect(refundKey.startsWith('refund_')).toBe(true);
  });

  it('should generate 8-character random ID', () => {
    const key = generateIdempotencyKey('test');
    const parts = key.split('_');
    expect(parts[2]).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Sprint 2 — Discount helpers
// ---------------------------------------------------------------------------

describe('getDiscountBase', () => {
  // Phase 27 (PROMO-05): pool_only/consumptions_only scopes retired — 'all'
  // is the only remaining DiscountScope member.
  it("scope 'all' returns itemsSubtotal + poolTotal", () => {
    expect(getDiscountBase(80, 20, 'all')).toBe(100);
  });
});

describe('calculateDiscountAmount', () => {
  it('percent 10% on $100 base → $10.00', () => {
    expect(calculateDiscountAmount(100, 'percent', 10)).toBe(10);
  });

  it('percent 0% → $0', () => {
    expect(calculateDiscountAmount(100, 'percent', 0)).toBe(0);
  });

  it('fixed $20 on $100 base → $20.00', () => {
    expect(calculateDiscountAmount(100, 'fixed', 20)).toBe(20);
  });

  it('fixed $200 on $100 base → clamped to $100.00', () => {
    expect(calculateDiscountAmount(100, 'fixed', 200)).toBe(100);
  });

  it('percent 100% → equals base', () => {
    expect(calculateDiscountAmount(100, 'percent', 100)).toBe(100);
  });

  it('base $0 → always $0', () => {
    expect(calculateDiscountAmount(0, 'percent', 50)).toBe(0);
    expect(calculateDiscountAmount(0, 'fixed', 50)).toBe(0);
  });

  it('calculateDiscountAmount never exceeds base (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(10000), noNaN: true }),
        fc.float({ min: Math.fround(0), max: Math.fround(100), noNaN: true }),
        fc.oneof(fc.constant('percent' as const), fc.constant('fixed' as const)),
        (base, value, type) => {
          const result = calculateDiscountAmount(base, type, value);
          // The function rounds to 2 decimal places; allow up to 0.005 rounding tolerance.
          // The result must never exceed the 2dp-rounded base by more than the rounding epsilon.
          const roundedBase = Math.round(base * 100) / 100;
          return result <= roundedBase + 0.005 && result >= 0;
        }
      )
    );
  });
});

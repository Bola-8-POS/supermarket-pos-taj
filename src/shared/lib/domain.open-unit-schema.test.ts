import { describe, expect, it } from 'vitest';
import { OpenUnitCorrectionSchema, OpenUnitSchema, ProductSchema } from './domain';

const baseOpenUnit = {
  id: '00000000-0000-0000-0000-000000000001',
  productId: '00000000-0000-0000-0000-000000000002',
  remainingCount: 19,
  status: 'active',
  openedBy: '00000000-0000-0000-0000-000000000003',
  openedAt: '2026-07-30T10:00:00.000Z',
  closedBy: null,
  closedAt: null,
  closedReason: null,
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
};

describe('OpenUnitSchema', () => {
  it('accepts an active row with a positive remainingCount and coerces openedAt to a Date', () => {
    const result = OpenUnitSchema.parse(baseOpenUnit);
    expect(result.status).toBe('active');
    expect(result.remainingCount).toBe(19);
    expect(result.openedAt).toBeInstanceOf(Date);
  });

  it('rejects a negative remainingCount', () => {
    const result = OpenUnitSchema.safeParse({ ...baseOpenUnit, remainingCount: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a status outside active/exhausted/void', () => {
    const result = OpenUnitSchema.safeParse({ ...baseOpenUnit, status: 'closed' });
    expect(result.success).toBe(false);
  });

  it('accepts exhausted and void statuses', () => {
    expect(OpenUnitSchema.safeParse({ ...baseOpenUnit, status: 'exhausted' }).success).toBe(true);
    expect(OpenUnitSchema.safeParse({ ...baseOpenUnit, status: 'void' }).success).toBe(true);
  });
});

describe('OpenUnitCorrectionSchema', () => {
  const baseCorrection = {
    openUnitId: '00000000-0000-0000-0000-000000000001',
    remainingCount: 5,
    reason: 'recounted',
  };

  it('accepts a valid correction', () => {
    const result = OpenUnitCorrectionSchema.safeParse(baseCorrection);
    expect(result.success).toBe(true);
  });

  it('rejects a blank/whitespace-only reason', () => {
    expect(OpenUnitCorrectionSchema.safeParse({ ...baseCorrection, reason: '' }).success).toBe(false);
    expect(OpenUnitCorrectionSchema.safeParse({ ...baseCorrection, reason: '   ' }).success).toBe(false);
  });

  it('rejects a negative remainingCount', () => {
    const result = OpenUnitCorrectionSchema.safeParse({ ...baseCorrection, remainingCount: -1 });
    expect(result.success).toBe(false);
  });
});

describe('ProductSchema unitsPerPackage / parentProductId fields', () => {
  const baseProduct = {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Marlboro Box',
    categoryId: '00000000-0000-0000-0000-000000000002',
    basePrice: 8000,
    happyHourPrice: null,
    sku: null,
    isActive: true,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
  };

  it('accepts both fields as null (the state of every existing product)', () => {
    const result = ProductSchema.parse(baseProduct);
    expect(result.unitsPerPackage).toBeNull();
    expect(result.parentProductId).toBeNull();
  });

  it('accepts a positive integer unitsPerPackage and a uuid parentProductId', () => {
    const result = ProductSchema.parse({
      ...baseProduct,
      unitsPerPackage: 20,
      parentProductId: '00000000-0000-0000-0000-000000000009',
    });
    expect(result.unitsPerPackage).toBe(20);
    expect(result.parentProductId).toBe('00000000-0000-0000-0000-000000000009');
  });

  it('rejects unitsPerPackage: 0', () => {
    const result = ProductSchema.safeParse({ ...baseProduct, unitsPerPackage: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid parentProductId', () => {
    const result = ProductSchema.safeParse({ ...baseProduct, parentProductId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});

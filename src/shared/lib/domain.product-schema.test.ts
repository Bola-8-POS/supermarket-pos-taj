import { describe, expect, it } from 'vitest';
import { ProductCreateSchema, ProductSchema, ProductUpdateSchema } from './domain';

const baseProduct = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Club Soda',
  categoryId: '00000000-0000-0000-0000-000000000002',
  basePrice: 3500,
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

describe('ProductSchema stock_threshold field', () => {
  it('accepts null stock_threshold (AC-3: existing products default to NULL)', () => {
    const result = ProductSchema.parse(baseProduct);
    expect(result.stock_threshold).toBeNull();
  });

  it('accepts a positive numeric threshold', () => {
    const result = ProductSchema.parse({ ...baseProduct, stock_threshold: 10 });
    expect(result.stock_threshold).toBe(10);
  });

  it('accepts zero as a valid threshold value', () => {
    const result = ProductSchema.parse({ ...baseProduct, stock_threshold: 0 });
    expect(result.stock_threshold).toBe(0);
  });

  it('accepts fractional thresholds (e.g. half-case units)', () => {
    const result = ProductSchema.parse({ ...baseProduct, stock_threshold: 0.5 });
    expect(result.stock_threshold).toBe(0.5);
  });

  it('rejects missing stock_threshold field (field is required, not optional)', () => {
    const withoutThreshold = Object.fromEntries(
      Object.entries(baseProduct).filter(([k]) => k !== 'stock_threshold')
    );
    expect(() => ProductSchema.parse(withoutThreshold)).toThrow();
  });
});

describe('ProductCreateSchema/ProductUpdateSchema weightAmount/weightUnit (Phase 32 D-06/D-07)', () => {
  const baseCreate = Object.fromEntries(Object.entries(baseProduct).filter(([k]) => k !== 'id'));

  it('ProductCreateSchema accepts both weightAmount/weightUnit null', () => {
    const result = ProductCreateSchema.safeParse(baseCreate);
    expect(result.success).toBe(true);
  });

  it('ProductCreateSchema accepts both weightAmount/weightUnit set', () => {
    const result = ProductCreateSchema.safeParse({
      ...baseCreate,
      weightAmount: 0.5,
      weightUnit: 'kg',
    });
    expect(result.success).toBe(true);
  });

  it('ProductCreateSchema rejects weightAmount set with weightUnit null', () => {
    const result = ProductCreateSchema.safeParse({
      ...baseCreate,
      weightAmount: 0.5,
      weightUnit: null,
    });
    expect(result.success).toBe(false);
  });

  it('ProductCreateSchema rejects weightAmount null with weightUnit set', () => {
    const result = ProductCreateSchema.safeParse({
      ...baseCreate,
      weightAmount: null,
      weightUnit: 'kg',
    });
    expect(result.success).toBe(false);
  });

  it('ProductUpdateSchema accepts neither weightAmount nor weightUnit present (partial update)', () => {
    const result = ProductUpdateSchema.safeParse({
      id: baseProduct.id,
      name: 'Renamed',
    });
    expect(result.success).toBe(true);
  });

  it('ProductUpdateSchema rejects weightAmount present with weightUnit absent', () => {
    const result = ProductUpdateSchema.safeParse({
      id: baseProduct.id,
      weightAmount: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects weightAmount of 0 or negative (.positive())', () => {
    expect(
      ProductCreateSchema.safeParse({ ...baseCreate, weightAmount: 0, weightUnit: 'g' }).success
    ).toBe(false);
    expect(
      ProductCreateSchema.safeParse({ ...baseCreate, weightAmount: -1, weightUnit: 'g' }).success
    ).toBe(false);
  });

  it('rejects weightAmount with more than 2 decimal places, accepts exactly 2', () => {
    expect(
      ProductCreateSchema.safeParse({ ...baseCreate, weightAmount: 0.505, weightUnit: 'g' })
        .success
    ).toBe(false);
    expect(
      ProductCreateSchema.safeParse({ ...baseCreate, weightAmount: 0.5, weightUnit: 'g' }).success
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ProductUpdateSchema } from '@shared/lib/domain';
import {
  firstErroringTab,
  isProductFormDirty,
  tabForFieldError,
  tabsWithErrors,
  type ProductFormSnapshot,
} from './productDialogTabs';

const BASE_SNAPSHOT: ProductFormSnapshot = {
  name: 'Amul Ghee',
  categoryId: 'cat-1',
  basePrice: 250,
  sku: 'AMUL-GHEE-1L',
  barcode: '8901030702170',
  unitsPerPackageInput: '',
  parentProductIdInput: '',
  brandId: '',
  weightAmountInput: '',
  weightUnit: 'g',
  isActive: true,
  comboEligible: true,
  imageUrl: '',
  modifierIds: [],
  selectedSupplierIds: [],
};

describe('tabForFieldError', () => {
  it.each(['name', 'categoryId', 'basePrice', 'sku', 'barcode', 'isActive'])(
    '%s belongs to the details tab',
    key => {
      expect(tabForFieldError(key)).toBe('details');
    }
  );

  it.each(['unitsPerPackage', 'parentProductId', 'modifiers', 'imageUrl'])(
    '%s belongs to the links tab',
    key => {
      expect(tabForFieldError(key)).toBe('links');
    }
  );

  it('_form belongs to no tab', () => {
    expect(tabForFieldError('_form')).toBeNull();
  });

  it('an unmapped key falls back to details, never left unreachable', () => {
    expect(tabForFieldError('somethingUnmapped')).toBe('details');
  });

  it('never resolves to the photo tab for any key in ProductUpdateSchema field set', () => {
    const fields = Object.keys(ProductUpdateSchema.shape);
    for (const field of fields) {
      expect(tabForFieldError(field)).not.toBe('photo');
    }
  });
});

describe('firstErroringTab', () => {
  it('returns null when there are no field errors', () => {
    expect(firstErroringTab({})).toBeNull();
  });

  it('returns links when only a links field has an error', () => {
    expect(firstErroringTab({ imageUrl: 'x' })).toBe('links');
  });

  it('rail order decides ties, not object key order', () => {
    expect(firstErroringTab({ imageUrl: 'x', name: 'y' })).toBe('details');
    // Same errors, keys inserted in the opposite order — same result.
    expect(firstErroringTab({ name: 'y', imageUrl: 'x' })).toBe('details');
  });
});

describe('tabsWithErrors', () => {
  it('collects every tab holding at least one field error', () => {
    const tabs = tabsWithErrors({ name: 'a', imageUrl: 'b' });
    expect(tabs.has('details')).toBe(true);
    expect(tabs.has('links')).toBe(true);
    expect(tabs.size).toBe(2);
  });
});

describe('isProductFormDirty', () => {
  it('is false for an unmodified snapshot', () => {
    expect(isProductFormDirty(BASE_SNAPSHOT, { ...BASE_SNAPSHOT })).toBe(false);
  });

  it('is true when any single field differs', () => {
    expect(isProductFormDirty(BASE_SNAPSHOT, { ...BASE_SNAPSHOT, name: 'Changed' })).toBe(true);
  });

  it('is false again once a field is edited and restored to its original value', () => {
    const edited: ProductFormSnapshot = { ...BASE_SNAPSHOT, name: 'Changed' };
    const restored: ProductFormSnapshot = { ...edited, name: BASE_SNAPSHOT.name };
    expect(isProductFormDirty(BASE_SNAPSHOT, restored)).toBe(false);
  });

  it('treats array fields as order-independent', () => {
    const a: ProductFormSnapshot = { ...BASE_SNAPSHOT, modifierIds: ['1', '2'] };
    const b: ProductFormSnapshot = { ...BASE_SNAPSHOT, modifierIds: ['2', '1'] };
    expect(isProductFormDirty(a, b)).toBe(false);
  });
});

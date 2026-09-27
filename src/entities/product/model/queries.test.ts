import { describe, expect, it } from 'vitest';
import type { Tables } from '@shared/lib/supabase.types';
import { mapProductRow, productUpdateToRow, type ProductRow } from './queries';

function baseRow(overrides: Partial<Tables<'products'>> = {}): ProductRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Parle-G Biscuits',
    category_id: '22222222-2222-4222-8222-222222222222',
    base_price: 25,
    sku: null,
    is_active: true,
    sold_by_weight: false,
    image_url: null,
    photo_path: null,
    stock_threshold: null,
    barcode: null,
    units_per_package: null,
    parent_product_id: null,
    brand_id: null,
    weight_amount: null,
    weight_unit: null,
    combo_eligible: true,
    combo_price_override: null,
    is_combo: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null,
    category: null,
    product_modifiers: null,
    ...overrides,
  };
}

describe('mapProductRow', () => {
  it('maps combo_eligible:false through to the domain Product', () => {
    const result = mapProductRow(baseRow({ combo_eligible: false }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.comboEligible).toBe(false);
    }
  });

  it('maps combo_eligible:true through to the domain Product', () => {
    const result = mapProductRow(baseRow({ combo_eligible: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.comboEligible).toBe(true);
    }
  });
});

describe('productUpdateToRow', () => {
  it('writes combo_eligible:false when the patch turns it off', () => {
    expect(productUpdateToRow({ comboEligible: false })).toMatchObject({ combo_eligible: false });
  });

  it('writes combo_eligible:true when the patch turns it on', () => {
    expect(productUpdateToRow({ comboEligible: true })).toMatchObject({ combo_eligible: true });
  });

  it('omits combo_eligible when the patch does not touch it', () => {
    expect(productUpdateToRow({ name: 'Renamed' })).not.toHaveProperty('combo_eligible');
  });
});

import { describe, expect, it } from 'vitest';
import { InventoryAdjustReasonSchema, InventoryAdjustReason } from './domain';

describe('InventoryAdjustReasonSchema', () => {
  it('accepts all defined reason values', () => {
    const valid = [
      'sale',
      'manual_adjustment',
      'waste',
      'delivery',
      'correction',
      'physical_count',
    ];
    for (const v of valid) {
      expect(InventoryAdjustReasonSchema.parse(v)).toBe(v);
    }
  });

  it('includes physical_count — required for physical inventory count audit trail', () => {
    expect(InventoryAdjustReasonSchema.parse('physical_count')).toBe('physical_count');
  });

  it('rejects unknown reason values', () => {
    expect(() => InventoryAdjustReasonSchema.parse('unknown_reason')).toThrow();
    expect(() => InventoryAdjustReasonSchema.parse('')).toThrow();
  });

  it('InventoryAdjustReason.PHYSICAL_COUNT serializes to physical_count', () => {
    expect(InventoryAdjustReason.PHYSICAL_COUNT).toBe('physical_count');
    expect(InventoryAdjustReasonSchema.parse(InventoryAdjustReason.PHYSICAL_COUNT)).toBe(
      'physical_count'
    );
  });
});

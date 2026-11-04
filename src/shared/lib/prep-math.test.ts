import { describe, expect, it } from 'vitest';
import { computePrepConsumption } from './prep-math';

describe('computePrepConsumption', () => {
  it('debits single ingredient: 10 portions × 100g ÷ yield=1 → −1000', () => {
    const result = computePrepConsumption(10, [{ ingredientId: 'a', qty: 100 }], 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.delta).toBeCloseTo(-1000, 5);
    expect(result[0]?.ingredientId).toBe('a');
  });

  it('handles partial yield: 3 produced × 200g ÷ yield=5 → −120', () => {
    const result = computePrepConsumption(3, [{ ingredientId: 'b', qty: 200 }], 5);
    expect(result[0]?.delta).toBeCloseTo(-120, 5);
  });

  it('handles multiple raw ingredients', () => {
    const result = computePrepConsumption(
      5,
      [
        { ingredientId: 'c', qty: 100 },
        { ingredientId: 'd', qty: 50 },
      ],
      2,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.delta).toBeCloseTo(-250, 5);
    expect(result[1]?.delta).toBeCloseTo(-125, 5);
  });

  it('returns empty array when no recipe items', () => {
    const result = computePrepConsumption(1, [], 1);
    expect(result).toHaveLength(0);
  });

  it('all deltas are negative (consumption)', () => {
    const result = computePrepConsumption(
      2,
      [
        { ingredientId: 'e', qty: 10 },
        { ingredientId: 'f', qty: 20 },
      ],
      1,
    );
    result.forEach(r => {
      expect(r.delta).toBeLessThan(0);
    });
  });
});

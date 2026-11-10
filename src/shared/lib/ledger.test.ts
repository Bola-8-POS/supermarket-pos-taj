import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

// ============================================================================
// P4 — Ledger invariant (property test)
//
// For any sequence of N stock movements, the sum of all deltas must equal
// the final quantity_on_hand. This is the core invariant of the append-only
// stock ledger.
//
// This test is PURE — it simulates the invariant arithmetically without hitting
// the DB. The integration test for the actual RPC lives in
// entities/ingredient/model/queries.test.ts.
// ============================================================================

/**
 * Simulate N stock movements applied to an ingredient starting at qty=0.
 * Returns { finalQty, sumOfDeltas } for invariant assertion.
 * Applies the INVENTORY_NEGATIVE guard: skips movements that would drive qty
 * below 0 for non-correction/physical_count reasons (mirroring RPC behavior).
 */
function simulateLedger(
  movements: Array<{ delta: number; reason: string }>,
): { finalQty: number; sumOfDeltas: number; acceptedMovements: typeof movements } {
  let qty = 0;
  const accepted: typeof movements = [];

  for (const m of movements) {
    const next = qty + m.delta;
    const isOverrideReason = m.reason === 'correction' || m.reason === 'physical_count';
    if (next < 0 && !isOverrideReason) {
      // Skip — would trigger INVENTORY_NEGATIVE in RPC
      continue;
    }
    qty = next;
    accepted.push(m);
  }

  return {
    finalQty: qty,
    sumOfDeltas: accepted.reduce((acc, m) => acc + m.delta, 0),
    acceptedMovements: accepted,
  };
}

describe('Ledger invariant', () => {
  test('empty movement list: qty stays 0', () => {
    const result = simulateLedger([]);
    expect(result.finalQty).toBe(0);
    expect(result.sumOfDeltas).toBe(0);
  });

  test('single positive movement: qty equals delta', () => {
    const result = simulateLedger([{ delta: 500, reason: 'delivery' }]);
    expect(result.finalQty).toBe(500);
    expect(result.sumOfDeltas).toBe(500);
  });

  test('positive then negative (waste): qty equals sum', () => {
    const result = simulateLedger([
      { delta: 1000, reason: 'delivery' },
      { delta: -200, reason: 'waste' },
    ]);
    expect(result.finalQty).toBe(800);
    expect(result.sumOfDeltas).toBe(800);
  });

  test('correction can drive qty negative', () => {
    const result = simulateLedger([
      { delta: 100, reason: 'delivery' },
      { delta: -200, reason: 'correction' },
    ]);
    expect(result.finalQty).toBe(-100);
    expect(result.sumOfDeltas).toBe(-100);
  });
});

// ============================================================================
// P4 — Property test: sum(deltas) = quantity_on_hand for any sequence
// ============================================================================

test('P4: ledger invariant — sum(accepted deltas) = finalQty for N random movements', () => {
  const REASONS = ['delivery', 'waste', 'correction', 'physical_count', 'sale', 'refund'] as const;

  fc.assert(
    fc.property(
      // Generate 1–20 movements with arbitrary deltas and reasons
      fc.array(
        fc.record({
          delta: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
          reason: fc.constantFrom(...REASONS),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      movements => {
        const { finalQty, sumOfDeltas } = simulateLedger(movements);
        // The invariant: sum of all ACCEPTED deltas equals final quantity
        expect(Math.abs(finalQty - sumOfDeltas)).toBeLessThan(1e-9);
      },
    ),
    { numRuns: 500 },
  );
});

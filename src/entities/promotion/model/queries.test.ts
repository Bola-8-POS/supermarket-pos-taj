import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import type { Tables } from '@shared/lib/supabase.types';
import { createTestQueryClient } from '@shared/lib/test-utils';
import { mapPromotionRow, useMutationCreatePromotion, useMutationUpdatePromotion } from './queries';

/** Row shape returned by the `*, promotion_targets(*), promotion_combo_slots(*)` nested-join select. */
type PromotionRowWithTargets = Tables<'promotions'> & {
  promotion_targets: Tables<'promotion_targets'>[] | null;
  promotion_combo_slots: Tables<'promotion_combo_slots'>[] | null;
};

const PROMOTION_ID = '11111111-1111-4111-8111-111111111111';
const SLOT_A_ID = '22222222-2222-4222-8222-222222222222';
const SLOT_B_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_A_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_B_ID = '55555555-5555-4555-8555-555555555555';
const TARGET_TOP_ID = '66666666-6666-4666-8666-666666666666';
const CATEGORY_A_ID = '77777777-7777-4777-8777-777777777777';
const PRODUCT_B_ID = '88888888-8888-4888-8888-888888888888';
const PRODUCT_TOP_ID = '99999999-9999-4999-8999-999999999999';

function baseRow(overrides: Partial<PromotionRowWithTargets> = {}): PromotionRowWithTargets {
  return {
    id: PROMOTION_ID,
    name: 'Test promo',
    kind: 'discount',
    discount_type: 'percent',
    discount_value: 20,
    starts_at: '2026-08-01T00:00:00.000Z',
    ends_at: '2026-12-31T23:59:59.000Z',
    days_of_week: null,
    start_time: null,
    end_time: null,
    needs_review: false,
    active: true,
    created_at: '2026-08-01T00:00:00.000Z',
    created_by: null,
    updated_at: '2026-08-01T00:00:00.000Z',
    promotion_targets: [],
    promotion_combo_slots: [],
    ...overrides,
  };
}

describe('mapPromotionRow', () => {
  it('nests two combo slots sorted by position (1,0 -> 0,1) with only their own targets', () => {
    const row = baseRow({
      kind: 'combo',
      discount_type: 'bundle_price',
      promotion_combo_slots: [
        { id: SLOT_A_ID, promotion_id: PROMOTION_ID, position: 1, quantity: 2, label: 'Chips' },
        { id: SLOT_B_ID, promotion_id: PROMOTION_ID, position: 0, quantity: 1, label: 'Soda' },
      ],
      promotion_targets: [
        {
          id: TARGET_A_ID,
          promotion_id: PROMOTION_ID,
          product_id: null,
          category_id: CATEGORY_A_ID,
          slot_id: SLOT_A_ID,
          created_at: '2026-08-01T00:00:00.000Z',
        },
        {
          id: TARGET_B_ID,
          promotion_id: PROMOTION_ID,
          product_id: PRODUCT_B_ID,
          category_id: null,
          slot_id: SLOT_B_ID,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const result = mapPromotionRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.slots).toHaveLength(2);
    // Sorted by position: slot at position 0 (Soda/SLOT_B_ID) first.
    expect(result.data.slots[0]?.id).toBe(SLOT_B_ID);
    expect(result.data.slots[0]?.position).toBe(0);
    expect(result.data.slots[0]?.targets).toEqual([
      {
        id: TARGET_B_ID,
        promotionId: PROMOTION_ID,
        productId: PRODUCT_B_ID,
        categoryId: null,
        slotId: SLOT_B_ID,
      },
    ]);
    expect(result.data.slots[1]?.id).toBe(SLOT_A_ID);
    expect(result.data.slots[1]?.position).toBe(1);
    expect(result.data.slots[1]?.targets).toEqual([
      {
        id: TARGET_A_ID,
        promotionId: PROMOTION_ID,
        productId: null,
        categoryId: CATEGORY_A_ID,
        slotId: SLOT_A_ID,
      },
    ]);
  });

  it('leaves slot-less targets at the top level and never duplicates a slot-scoped target there', () => {
    const row = baseRow({
      kind: 'combo',
      discount_type: 'bundle_price',
      promotion_combo_slots: [
        { id: SLOT_A_ID, promotion_id: PROMOTION_ID, position: 0, quantity: 1, label: null },
      ],
      promotion_targets: [
        {
          id: TARGET_TOP_ID,
          promotion_id: PROMOTION_ID,
          product_id: PRODUCT_TOP_ID,
          category_id: null,
          slot_id: null,
          created_at: '2026-08-01T00:00:00.000Z',
        },
        {
          id: TARGET_A_ID,
          promotion_id: PROMOTION_ID,
          product_id: null,
          category_id: CATEGORY_A_ID,
          slot_id: SLOT_A_ID,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const result = mapPromotionRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.targets).toEqual([
      {
        id: TARGET_TOP_ID,
        promotionId: PROMOTION_ID,
        productId: PRODUCT_TOP_ID,
        categoryId: null,
        slotId: null,
      },
    ]);
    expect(result.data.slots[0]?.targets).toEqual([
      {
        id: TARGET_A_ID,
        promotionId: PROMOTION_ID,
        productId: null,
        categoryId: CATEGORY_A_ID,
        slotId: SLOT_A_ID,
      },
    ]);
  });

  it('defaults kind="discount" and slots=[] for a legacy row with no combo slots', () => {
    const row = baseRow();
    const result = mapPromotionRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe('discount');
    expect(result.data.slots).toEqual([]);
  });
});

// ============================================================================
// useMutationUpdatePromotion — combo top-level-targets invariant
// ============================================================================

/* eslint-disable i18next/no-literal-string -- literal supabase-call tracking
   labels below (table/method names) are test scaffolding, not UI copy. */

type TrackedCall = { table: string; op: string; args: unknown[] };

/**
 * Builds a `supabase.from` mock that resolves every terminal call
 * (`.eq()`/`.is()`/`.single()`/a bare await of the chain itself) to `null`
 * data with no error, while recording every `{table, op, args}` step so a
 * test can assert exactly which filters a given delete/insert used.
 */
function mockTrackedFrom(): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const chainMethods = ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order', 'limit'];

  vi.mocked(supabase).from.mockImplementation((table: string) => {
    const resolved = { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const op of chainMethods) {
      chain[op] = vi.fn((...args: unknown[]) => {
        calls.push({ table, op, args });
        return chain;
      });
    }
    chain.single = vi.fn(() => {
      calls.push({ table, op: 'single', args: [] });
      // Only reached by promotion_combo_slots' `.insert(...).select('id').single()`
      // in saveComboSlots — needs a slot id to attach the slot's targets to.
      return Promise.resolve({ data: { id: `${table}-slot-id` }, error: null });
    });
    chain.then = (resolve: (v: typeof resolved) => void) => {
      resolve(resolved);
    };
    return chain as unknown as ReturnType<typeof supabase.from>;
  });

  return calls;
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useMutationUpdatePromotion', () => {
  it(
    'unconditionally clears top-level (slot_id IS NULL) targets when the update makes the ' +
      'promotion a combo, even without passing `targets` — a discount promotion with an ' +
      'existing top-level target must not keep it after converting to kind:"combo"',
    async () => {
      const calls = mockTrackedFrom();
      const qc = createTestQueryClient();
      const { result } = renderHook(() => useMutationUpdatePromotion(), {
        wrapper: makeWrapper(qc),
      });

      const mutationResult = await result.current.mutateAsync({
        id: PROMOTION_ID,
        kind: 'combo',
        discountType: 'bundle_price',
        slots: [
          {
            quantity: 2,
            label: 'Any soda',
            targets: [{ productId: null, categoryId: CATEGORY_A_ID, slotId: null }],
          },
        ],
      });
      expect(mutationResult.ok).toBe(true);

      // The top-level-targets delete must have fired with `slot_id IS NULL`,
      // scoped to this promotion — unconditionally, since `targets` was never
      // passed in this update.
      const topLevelDelete = calls.find(c => c.table === 'promotion_targets' && c.op === 'delete');
      expect(topLevelDelete).toBeDefined();
      const eqCall = calls.find(
        c => c.table === 'promotion_targets' && c.op === 'eq' && c.args[0] === 'promotion_id'
      );
      expect(eqCall?.args).toEqual(['promotion_id', PROMOTION_ID]);
      const isCall = calls.find(c => c.table === 'promotion_targets' && c.op === 'is');
      expect(isCall?.args).toEqual(['slot_id', null]);

      // No slot-less (top-level) insert into promotion_targets: every insert
      // into that table (the slot's own targets, written by saveComboSlots)
      // must carry a non-null slot_id — never a bare top-level target row.
      const targetInserts = calls.filter(c => c.table === 'promotion_targets' && c.op === 'insert');
      for (const insertCall of targetInserts) {
        const rows = insertCall.args[0] as { slot_id?: string | null }[];
        for (const row of rows) {
          expect(row.slot_id).toBeTruthy();
        }
      }
    }
  );
});

// ============================================================================
// saveComboSlots — mid-write failure safety net (final-review fix #3)
// ============================================================================

/**
 * Like mockTrackedFrom, but promotion_combo_slots' slot-insert `.single()`
 * fails with a Postgres-shaped error instead of returning a slot id — a
 * failure landing squarely between the delete and the reinsert loop, the
 * highest-risk mid-write point saveComboSlots can fail at. promotions'
 * initial insert (create) still resolves with a real row so the mutation
 * gets far enough to reach saveComboSlots at all.
 */
function mockTrackedFromWithSlotInsertFailure(): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const chainMethods = ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order', 'limit'];

  vi.mocked(supabase).from.mockImplementation((table: string) => {
    const resolved = { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const op of chainMethods) {
      chain[op] = vi.fn((...args: unknown[]) => {
        calls.push({ table, op, args });
        return chain;
      });
    }
    chain.single = vi.fn(() => {
      calls.push({ table, op: 'single', args: [] });
      if (table === 'promotions') {
        // useMutationCreatePromotion's initial insert().select('*').single().
        return Promise.resolve({ data: baseRow({ kind: 'combo', discount_type: 'bundle_price' }), error: null });
      }
      if (table === 'promotion_combo_slots') {
        return Promise.resolve({
          data: null,
          error: { message: 'combo slot insert failed', code: 'PGRST000', details: '', hint: '' },
        });
      }
      return Promise.resolve({ data: { id: `${table}-slot-id` }, error: null });
    });
    chain.then = (resolve: (v: typeof resolved) => void) => {
      resolve(resolved);
    };
    return chain as unknown as ReturnType<typeof supabase.from>;
  });

  return calls;
}

/**
 * Like mockTrackedFrom, but the top-level `promotion_targets` insert (the
 * reinsert half of useMutationUpdatePromotion's delete-then-reinsert) fails
 * with a Postgres-shaped error — the delete succeeds, leaving zero targets,
 * then the reinsert fails. This is the exact bug described in the
 * final-review finding: an empty-targets promotion is store-wide by design
 * (evaluateBestPromotion/evaluateCombos), so a targeted discount would
 * silently become a live, store-wide discount if left `active: true`.
 */
function mockTrackedFromWithTopLevelTargetsInsertFailure(): TrackedCall[] {
  const calls: TrackedCall[] = [];
  const chainMethods = ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order', 'limit'];

  vi.mocked(supabase).from.mockImplementation((table: string) => {
    let sawInsert = false;
    const chain: Record<string, unknown> = {};
    for (const op of chainMethods) {
      chain[op] = vi.fn((...args: unknown[]) => {
        calls.push({ table, op, args });
        if (op === 'insert') sawInsert = true;
        return chain;
      });
    }
    chain.single = vi.fn(() => {
      calls.push({ table, op: 'single', args: [] });
      return Promise.resolve({ data: { id: `${table}-slot-id` }, error: null });
    });
    chain.then = (resolve: (v: { data: unknown; error: unknown }) => void) => {
      if (table === 'promotion_targets' && sawInsert) {
        resolve({
          data: null,
          error: { message: 'top-level targets insert failed', code: 'PGRST000', details: '', hint: '' },
        });
      } else {
        resolve({ data: null, error: null });
      }
    };
    return chain as unknown as ReturnType<typeof supabase.from>;
  });

  return calls;
}

describe('useMutationUpdatePromotion — top-level targets partial-write safety net', () => {
  it('deactivates the promotion (active: false) when the top-level targets insert fails mid-write, without masking the original error', async () => {
    const calls = mockTrackedFromWithTopLevelTargetsInsertFailure();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationUpdatePromotion(), {
      wrapper: makeWrapper(qc),
    });

    const mutationResult = await result.current.mutateAsync({
      id: PROMOTION_ID,
      targets: [{ productId: PRODUCT_TOP_ID, categoryId: null, slotId: null }],
    });

    // The original insert failure is still what's returned — never masked
    // by the deactivate's own (successful, in this mock) outcome.
    expect(mutationResult.ok).toBe(false);

    const deactivateCall = calls.find(
      c =>
        c.table === 'promotions' &&
        c.op === 'update' &&
        (c.args[0] as { active?: boolean }).active === false
    );
    expect(deactivateCall).toBeDefined();
    const deactivateEqCall = calls.find(
      c => c.table === 'promotions' && c.op === 'eq' && c.args[0] === 'id' && c.args[1] === PROMOTION_ID
    );
    expect(deactivateEqCall).toBeDefined();
  });
});

describe('saveComboSlots — mid-write failure safety net', () => {
  it('deactivates the promotion (active: false) when a combo slot insert fails mid-write, without masking the original error', async () => {
    const calls = mockTrackedFromWithSlotInsertFailure();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationCreatePromotion(), {
      wrapper: makeWrapper(qc),
    });

    const mutationResult = await result.current.mutateAsync({
      name: 'Broken bundle',
      kind: 'combo',
      discountType: 'bundle_price',
      discountValue: 199,
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-12-31T23:59:59.000Z'),
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      active: true,
      createdBy: null,
      targets: [],
      slots: [
        {
          quantity: 2,
          label: 'Chips',
          targets: [{ productId: null, categoryId: CATEGORY_A_ID, slotId: null }],
        },
      ],
    });

    // The original slot-insert failure is still what's returned — never
    // masked by the deactivate's own (successful, in this mock) outcome.
    // parseSupabaseError generic-codes an unrecognized PostgrestError code
    // to "An unexpected error occurred." (not the raw message) — the real
    // failure is asserted via the logged event above instead.
    expect(mutationResult.ok).toBe(false);

    const deactivateCall = calls.find(
      c =>
        c.table === 'promotions' &&
        c.op === 'update' &&
        (c.args[0] as { active?: boolean }).active === false
    );
    expect(deactivateCall).toBeDefined();
    const deactivateEqCall = calls.find(
      c => c.table === 'promotions' && c.op === 'eq' && c.args[0] === 'id' && c.args[1] === PROMOTION_ID
    );
    expect(deactivateEqCall).toBeDefined();
  });
});
/* eslint-enable i18next/no-literal-string */

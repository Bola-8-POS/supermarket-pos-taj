import { describe, expect, it, vi } from 'vitest';
import type { Tables } from '@shared/lib/supabase.types';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({
  logger: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() },
}));

import { fetchPromotionRows, mergePromotionChildren } from './queries';

const promo = (id: string) => ({ id, name: id }) as unknown as Tables<'promotions'>;
const target = (id: string, promotion_id: string) =>
  ({ id, promotion_id, product_id: 'p', slot_id: null }) as unknown as Tables<'promotion_targets'>;
const slot = (id: string, promotion_id: string) =>
  ({ id, promotion_id, position: 0, quantity: 1 }) as unknown as Tables<'promotion_combo_slots'>;

describe('mergePromotionChildren', () => {
  it('children are merged under their promotion in the original shape', () => {
    const rows = mergePromotionChildren(
      [promo('a'), promo('b')],
      [target('t1', 'b'), target('t2', 'a'), target('t3', 'b')],
      [slot('s1', 'a')]
    );
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    expect(rows[0]?.promotion_targets?.map(t => t.id)).toEqual(['t2']);
    expect(rows[1]?.promotion_targets?.map(t => t.id)).toEqual(['t1', 't3']);
    expect(rows[0]?.promotion_combo_slots?.map(s => s.id)).toEqual(['s1']);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ['id', 'name', 'promotion_combo_slots', 'promotion_targets'].sort()
    );
  });

  it('a promotion with no children gets empty arrays', () => {
    const [row] = mergePromotionChildren([promo('a')], [], []);
    expect(row?.promotion_targets).toEqual([]);
    expect(row?.promotion_combo_slots).toEqual([]);
  });

  it('a child whose parent is missing is dropped and logged', () => {
    const rows = mergePromotionChildren([promo('a')], [target('t1', 'ghost')], [slot('s1', 'ghost')]);
    expect(rows[0]?.promotion_targets).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

/** A fake client: each table serves its (per-call) rows through select().order()...range(). */
function fakeClient(tables: Record<string, unknown[][]>) {
  const calls: Record<string, number> = {};
  const client = {
    from: (table: string) => {
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const sets = tables[table] ?? [[]];
      const rows = sets[Math.min(n, sets.length) - 1] ?? [];
      const chain = {
        select: () => chain,
        order: () => chain,
        range: async (from: number) => ({
          data: rows.slice(from, from + 1000),
          error: null,
          count: rows.length,
        }),
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}
const withCount = (id: string, targets: number, slots: number) => ({
  id,
  promotion_targets: [{ count: targets }],
  promotion_combo_slots: [{ count: slots }],
});

describe('fetchPromotionRows', () => {
  it('a promotion whose merged targets differ from its count triggers a refetch', async () => {
    const { client, calls } = fakeClient({
      promotions: [[withCount('a', 2, 0)]],
      promotion_targets: [[target('t1', 'a')], [target('t1', 'a'), target('t2', 'a')]],
    });
    const r = await fetchPromotionRows(client);
    expect(r.ok && r.data[0]?.promotion_targets).toHaveLength(2);
    expect(calls.promotion_targets).toBe(2);
    expect(r.ok && Object.keys(r.data[0] ?? {}).sort()).toEqual(
      ['id', 'promotion_combo_slots', 'promotion_targets'].sort()
    );
  });

  it('a persistent mismatch returns an error, not a store-wide promotion', async () => {
    const { client } = fakeClient({
      promotions: [[withCount('a', 2, 0)]],
      promotion_targets: [[target('t1', 'a')]],
    });
    const r = await fetchPromotionRows(client);
    expect(r.ok).toBe(false);
  });
  it('a promotion with no readable child count is a mismatch, not store-wide', async () => {
    const { client } = fakeClient({
      promotions: [[{ id: 'a', promotion_targets: null, promotion_combo_slots: null }]],
    });
    const r = await fetchPromotionRows(client);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('LIST_CHANGED');
  });
});

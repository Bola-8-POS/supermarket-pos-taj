/* eslint-disable */
// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: combo-promotions schema (Task 1, migration
 * 20260913000001_combo_promotions_schema.sql).
 *
 * Uses the service-role client directly (bypassing RLS) — same pattern as
 * promotion-rpc.integration.test.ts / caja-terminal-rpc.integration.test.ts.
 *
 * Run: npx vitest run src/entities/promotion/model/combo-schema.integration.test.ts --project integration
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { testDb as db } from '@shared/lib/supabase-test-client';

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

const itPlain = hasEnv ? it : it.skip;

function futureRange(): { starts_at: string; ends_at: string } {
  const now = new Date();
  return {
    starts_at: new Date(now.getTime() - 60_000).toISOString(),
    ends_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
  };
}

async function insertPromotion(overrides: Record<string, unknown>) {
  return db
    .from('promotions')
    .insert({
      name: `ITEST combo ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...futureRange(),
      ...overrides,
    } as never)
    .select('*')
    .single();
}

afterAll(async () => {
  const { data } = await db.from('promotions').select('id').ilike('name', 'ITEST combo%');
  const ids = (data ?? []).map(r => r.id as string);
  if (ids.length > 0) {
    await db.from('promotion_targets').delete().in('promotion_id', ids);
    await db.from('promotion_combo_slots').delete().in('promotion_id', ids);
    await db.from('promotions').delete().in('id', ids);
  }
});

describe('combo promotions schema (integration)', () => {
  itPlain('kind=combo with discount_type=bundle_price and integer-friendly value succeeds', async () => {
    const r = await insertPromotion({
      kind: 'combo',
      discount_type: 'bundle_price',
      discount_value: 199,
    });
    expect(r.error).toBeNull();
    expect((r.data as { kind?: string } | null)?.kind).toBe('combo');
  });

  itPlain('kind=discount with discount_type=bundle_price fails 23514 (kind/type consistency)', async () => {
    const r = await insertPromotion({
      kind: 'discount',
      discount_type: 'bundle_price',
      discount_value: 199,
    });
    expect(r.error?.code).toBe('23514');
  });

  itPlain('kind=combo with discount_type=cheapest_free and non-integer value fails 23514', async () => {
    const r = await insertPromotion({
      kind: 'combo',
      discount_type: 'cheapest_free',
      discount_value: 1.5,
    });
    expect(r.error?.code).toBe('23514');
  });

  itPlain('promotion_combo_slots: valid quantity inserts; quantity 0 fails; duplicate position fails 23505', async () => {
    const promo = await insertPromotion({
      kind: 'combo',
      discount_type: 'bundle_price',
      discount_value: 50,
    });
    expect(promo.error).toBeNull();
    const promotionId = (promo.data as { id: string }).id;

    const slot = await db
      .from('promotion_combo_slots')
      .insert({ promotion_id: promotionId, position: 0, quantity: 3 } as never)
      .select('*')
      .single();
    expect(slot.error).toBeNull();
    expect((slot.data as { quantity?: number } | null)?.quantity).toBe(3);

    const badQty = await db
      .from('promotion_combo_slots')
      .insert({ promotion_id: promotionId, position: 1, quantity: 0 } as never)
      .select('id')
      .single();
    expect(badQty.error?.code).toBe('23514');

    const dupPosition = await db
      .from('promotion_combo_slots')
      .insert({ promotion_id: promotionId, position: 0, quantity: 1 } as never)
      .select('id')
      .single();
    expect(dupPosition.error?.code).toBe('23505');
  });

  itPlain('promotion_targets.slot_id inserts and cascades on slot delete', async () => {
    const promo = await insertPromotion({
      kind: 'combo',
      discount_type: 'bundle_price',
      discount_value: 50,
    });
    expect(promo.error).toBeNull();
    const promotionId = (promo.data as { id: string }).id;

    const category = await db
      .from('categories')
      .insert({ name: `ITEST combo category ${Date.now()}` } as never)
      .select('id')
      .single();
    expect(category.error).toBeNull();
    const categoryId = (category.data as { id: string }).id;

    const slot = await db
      .from('promotion_combo_slots')
      .insert({ promotion_id: promotionId, position: 0, quantity: 1 } as never)
      .select('id')
      .single();
    expect(slot.error).toBeNull();
    const slotId = (slot.data as { id: string }).id;

    const target = await db
      .from('promotion_targets')
      .insert({ promotion_id: promotionId, category_id: categoryId, slot_id: slotId } as never)
      .select('id')
      .single();
    expect(target.error).toBeNull();
    const targetId = (target.data as { id: string }).id;

    await db.from('promotion_combo_slots').delete().eq('id', slotId);

    const targetAfter = await db.from('promotion_targets').select('id').eq('id', targetId).maybeSingle();
    expect(targetAfter.data).toBeNull();

    await db.from('categories').delete().eq('id', categoryId);
  });

  itPlain('categories.combo_eligible defaults to true', async () => {
    const category = await db
      .from('categories')
      .insert({ name: `ITEST combo category ${Date.now()}-default` } as never)
      .select('combo_eligible, id')
      .single();
    expect(category.error).toBeNull();
    expect((category.data as { combo_eligible?: boolean } | null)?.combo_eligible).toBe(true);
    await db.from('categories').delete().eq('id', (category.data as { id: string }).id);
  });
});

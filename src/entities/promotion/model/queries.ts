import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Promotion,
  PromotionComboSlotInput,
  PromotionCreate,
  PromotionUpdate,
} from '@shared/lib/domain';
import { PromotionSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  ok,
  supabaseMutation,
  supabaseQuery,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Tables, TablesInsert, TablesUpdate } from '@shared/lib/supabase.types';

// ============================================================================
// QUERY KEYS
// ============================================================================
/* eslint-disable i18next/no-literal-string -- TanStack Query cache-key
   namespace strings below are not UI copy. */

const PROMOTION_QUERY_KEY = ['promotions'] as const;

// ============================================================================
// ROW MAPPER
// ============================================================================

/** Row shape returned by the `*, promotion_targets(*), promotion_combo_slots(*)` nested-join select. */
type PromotionRowWithTargets = Tables<'promotions'> & {
  promotion_targets: Tables<'promotion_targets'>[] | null;
  promotion_combo_slots: Tables<'promotion_combo_slots'>[] | null;
};

function mapTargetRow(t: Tables<'promotion_targets'>) {
  return {
    id: t.id,
    promotionId: t.promotion_id,
    productId: t.product_id,
    categoryId: t.category_id,
    slotId: t.slot_id,
  };
}

/**
 * Pure row mapper — exported for unit testing. Slots are sorted by
 * `position`; each slot's `targets` are the `promotion_targets` rows whose
 * `slot_id` matches that slot's id. The promotion's top-level `targets` are
 * the rows with `slot_id === null` — a slot-scoped target never appears at
 * both levels.
 */
export function mapPromotionRow(row: PromotionRowWithTargets): Result<Promotion> {
  try {
    const allTargets = row.promotion_targets ?? [];
    const topLevelTargets = allTargets.filter(t => t.slot_id === null);
    const slots = [...(row.promotion_combo_slots ?? [])]
      .sort((a, b) => a.position - b.position)
      .map(s => ({
        id: s.id,
        promotionId: s.promotion_id,
        position: s.position,
        quantity: s.quantity,
        label: s.label,
        targets: allTargets.filter(t => t.slot_id === s.id).map(mapTargetRow),
      }));

    return ok(
      PromotionSchema.parse({
        id: row.id,
        name: row.name,
        targets: topLevelTargets.map(mapTargetRow),
        kind: row.kind,
        discountType: row.discount_type,
        discountValue: row.discount_value,
        startsAt: new Date(row.starts_at),
        endsAt: new Date(row.ends_at),
        daysOfWeek: row.days_of_week,
        startTime: row.start_time,
        endTime: row.end_time,
        needsReview: row.needs_review,
        active: row.active,
        createdAt: new Date(row.created_at),
        createdBy: row.created_by,
        slots,
      })
    );
  } catch (e) {
    return err(unknownError(e));
  }
}

/**
 * Best-effort safety net for a mid-write failure in any delete-then-reinsert
 * target/slot rewrite (final-review fix #3, extended to the top-level
 * `promotion_targets` rewrite in useMutationUpdatePromotion): a delete that
 * succeeds followed by an insert that fails can leave a promotion
 * `active: true` with zero targets — and zero targets means "store-wide" by
 * design (see evaluateBestPromotion/evaluateCombos), so a targeted discount
 * would silently become a live, store-wide discount on every product.
 * Deactivating never masks the original error — it's fired right before
 * returning it, and its own failure is only logged, never returned in place
 * of the real cause.
 */
async function deactivatePromotionAfterPartialWrite(promotionId: string): Promise<void> {
  const res = await supabaseMutation(() =>
    supabase.from('promotions').update({ active: false }).eq('id', promotionId)
  );
  if (!res.ok) {
    logger.error('promotions.partial_write_deactivate_failed', {
      promotionId,
      message: res.error.message,
    });
  }
}

/**
 * Rewrites a combo promotion's slots (delete-all-then-reinsert, mirroring
 * the existing targets update strategy — simplest correct approach for a
 * handful of slot rows per promotion). Deleting a slot cascades its
 * `promotion_targets` rows (DB `ON DELETE CASCADE` on `slot_id`), so slots
 * are deleted first, then reinserted with their own targets.
 */
async function saveComboSlots(
  promotionId: string,
  slots: PromotionComboSlotInput[]
): Promise<Result<null>> {
  const delRes = await supabaseMutation(() =>
    supabase.from('promotion_combo_slots').delete().eq('promotion_id', promotionId)
  );
  if (!delRes.ok) {
    logger.error('promotions.combo_slots_delete_failed', { message: delRes.error.message });
    await deactivatePromotionAfterPartialWrite(promotionId);
    return delRes;
  }

  for (const [index, slot] of slots.entries()) {
    const slotRow: TablesInsert<'promotion_combo_slots'> = {
      promotion_id: promotionId,
      position: index,
      quantity: slot.quantity,
      label: slot.label ?? null,
    };
    const slotRes = await supabaseMutation(() =>
      supabase.from('promotion_combo_slots').insert(slotRow).select('id').single()
    );
    if (!slotRes.ok) {
      logger.error('promotions.combo_slot_insert_failed', {
        message: slotRes.error.message,
        promotionId,
      });
      await deactivatePromotionAfterPartialWrite(promotionId);
      return slotRes;
    }
    const slotId = (slotRes.data as unknown as { id: string }).id;

    const targetRows: TablesInsert<'promotion_targets'>[] = slot.targets.map(t => ({
      promotion_id: promotionId,
      product_id: t.productId,
      category_id: t.categoryId,
      slot_id: slotId,
    }));
    const targetsRes = await supabaseMutation(() =>
      supabase.from('promotion_targets').insert(targetRows)
    );
    if (!targetsRes.ok) {
      logger.error('promotions.combo_slot_targets_insert_failed', {
        message: targetsRes.error.message,
        promotionId,
        slotId,
      });
      await deactivatePromotionAfterPartialWrite(promotionId);
      return targetsRes;
    }
  }

  return ok(null);
}

// ============================================================================
// HELPERS
// ============================================================================

function invalidatePromotionQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: PROMOTION_QUERY_KEY });
}

/** Re-fetches one promotion with its full nested targets/slots shape — used after a combo write, where the slots/targets just saved aren't available in-memory. */
async function fetchPromotionById(id: string): Promise<Result<Promotion>> {
  const res = await supabaseQuery(() =>
    supabase
      .from('promotions')
      .select('*, promotion_targets(*), promotion_combo_slots(*)')
      .eq('id', id)
      .single()
  );
  if (!res.ok) return res;
  return mapPromotionRow(res.data as unknown as PromotionRowWithTargets);
}

// ============================================================================
// QUERIES
// ============================================================================

/** Fetches all promotions (with their targets), newest first (stable default sort order). */
export function usePromotions() {
  const query = useQuery({
    queryKey: PROMOTION_QUERY_KEY,
    queryFn: async (): Promise<Result<Promotion[]>> => {
      const res = await supabaseQuery(() =>
        supabase
          .from('promotions')
          .select('*, promotion_targets(*), promotion_combo_slots(*)')
          .order('created_at', { ascending: false })
      );

      if (!res.ok) {
        logger.error('promotions.fetch_failed', {
          code: res.error.code,
          message: res.error.message,
        });
        return res;
      }

      const promotions: Promotion[] = [];
      for (const row of res.data as unknown as PromotionRowWithTargets[]) {
        const mapped = mapPromotionRow(row);
        if (!mapped.ok) {
          logger.error('promotions.map_failed', { message: mapped.error.message });
          return mapped;
        }
        promotions.push(mapped.data);
      }
      return ok(promotions);
    },
    staleTime: 5 * 60 * 1000,
  });

  const r = query.data;
  return {
    ...query,
    data: r?.ok ? r.data : undefined,
    resultError: r && !r.ok ? r.error : undefined,
    isEmpty: query.isSuccess && !!r?.ok && r.data.length === 0,
    isIdleOrLoading: query.isPending || query.isLoading,
  };
}

// ============================================================================
// MUTATIONS
// ============================================================================

export function useMutationCreatePromotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: PromotionCreate): Promise<Result<Promotion>> => {
      const isCombo = input.kind === 'combo';
      const insertRow: TablesInsert<'promotions'> = {
        name: input.name,
        kind: input.kind,
        discount_type: input.discountType,
        discount_value: input.discountValue,
        starts_at: input.startsAt.toISOString(),
        ends_at: input.endsAt.toISOString(),
        days_of_week: input.daysOfWeek,
        start_time: input.startTime,
        end_time: input.endTime,
        active: input.active,
        created_by: input.createdBy,
      };

      const res = await supabaseMutation(() =>
        supabase.from('promotions').insert(insertRow).select('*').single()
      );

      if (!res.ok) {
        logger.error('promotions.create_failed', { message: res.error.message });
        return res;
      }
      const promotionRow = res.data as unknown as Tables<'promotions'>;
      const promotionId = promotionRow.id;

      // Combo promotions: targets live under slots, not at the top level.
      if (isCombo) {
        const slotsRes = await saveComboSlots(promotionId, input.slots ?? []);
        if (!slotsRes.ok) {
          logger.error('promotions.create_combo_slots_failed', {
            message: slotsRes.error.message,
            promotionId,
          });
          // The promotion row itself was created successfully — do not
          // silently leave an orphaned combo promotion with no slots.
          // Surface the promotion id so the admin can retry via edit.
          return err(
            unknownError(
              new Error(
                `Promotion "${input.name}" (${promotionId}) was created, but its combo slots failed to save: ${slotsRes.error.message}. Edit the promotion to retry.`
              )
            )
          );
        }
        return fetchPromotionById(promotionId);
      }

      let insertedTargets: Tables<'promotion_targets'>[] = [];

      if (input.targets.length > 0) {
        const targetRows: TablesInsert<'promotion_targets'>[] = input.targets.map(t => ({
          promotion_id: promotionId,
          product_id: t.productId,
          category_id: t.categoryId,
        }));
        const targetsRes = await supabaseMutation(() =>
          supabase.from('promotion_targets').insert(targetRows).select('*')
        );
        if (!targetsRes.ok) {
          logger.error('promotions.create_targets_failed', {
            message: targetsRes.error.message,
            promotionId,
          });
          // The promotion row itself was created successfully — do not
          // silently leave an orphaned store-wide promotion. Surface the
          // promotion id so the admin can retry adding targets via edit.
          return err(
            unknownError(
              new Error(
                `Promotion "${input.name}" (${promotionId}) was created, but its targets failed to save: ${targetsRes.error.message}. Edit the promotion to retry.`
              )
            )
          );
        }
        insertedTargets = targetsRes.data as unknown as Tables<'promotion_targets'>[];
      }

      return mapPromotionRow({
        ...promotionRow,
        promotion_targets: insertedTargets,
        promotion_combo_slots: [],
      });
    },
    onSuccess: result => {
      if (result.ok) invalidatePromotionQueries(queryClient);
    },
  });
}

/**
 * Also used for the inline active/inactive Switch toggle — a partial
 * update of just `active`. No separate soft-delete/deactivate mutation:
 * "Delete" in the management UI (Plan 02) is a real DELETE relying on the
 * ON DELETE CASCADE/SET NULL semantics already in the schema.
 */
export function useMutationUpdatePromotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: PromotionUpdate): Promise<Result<null>> => {
      const { id, targets, slots, ...rest } = input;
      const isCombo = rest.kind === 'combo';
      const row: TablesUpdate<'promotions'> = {};
      if (rest.name !== undefined) row.name = rest.name;
      if (rest.kind !== undefined) row.kind = rest.kind;
      if (rest.discountType !== undefined) row.discount_type = rest.discountType;
      if (rest.discountValue !== undefined) row.discount_value = rest.discountValue;
      if (rest.startsAt !== undefined) row.starts_at = rest.startsAt.toISOString();
      if (rest.endsAt !== undefined) row.ends_at = rest.endsAt.toISOString();
      if (rest.daysOfWeek !== undefined) row.days_of_week = rest.daysOfWeek;
      if (rest.startTime !== undefined) row.start_time = rest.startTime;
      if (rest.endTime !== undefined) row.end_time = rest.endTime;
      if (rest.active !== undefined) row.active = rest.active;

      if (Object.keys(row).length > 0) {
        const res = await supabaseMutation(() =>
          supabase.from('promotions').update(row).eq('id', id)
        );
        if (!res.ok) {
          logger.error('promotions.update_failed', { message: res.error.message });
          return res;
        }
      }

      // Delete + reinsert (not a diff) — simplest correct approach for a
      // handful of target rows per promotion. Combo promotions keep no
      // top-level (slot-less) targets — their targets live under slots.
      // The clear must run whenever this update makes/keeps the promotion a
      // combo, even if the caller didn't pass `targets` at all — otherwise
      // converting an existing discount promotion (which may have top-level
      // targets) to kind:'combo' via `{ kind:'combo', slots:[...] }` alone
      // would leave its old top-level targets stale, violating the "combo
      // top-level targets are always []" invariant.
      const shouldRewriteTopLevelTargets = isCombo || targets !== undefined;
      if (shouldRewriteTopLevelTargets) {
        const delRes = await supabaseMutation(() =>
          supabase.from('promotion_targets').delete().eq('promotion_id', id).is('slot_id', null)
        );
        if (!delRes.ok) {
          logger.error('promotions.update_targets_delete_failed', {
            message: delRes.error.message,
          });
          await deactivatePromotionAfterPartialWrite(id);
          return delRes;
        }
        if (!isCombo && targets !== undefined && targets.length > 0) {
          const targetRows: TablesInsert<'promotion_targets'>[] = targets.map(t => ({
            promotion_id: id,
            product_id: t.productId,
            category_id: t.categoryId,
          }));
          const insRes = await supabaseMutation(() =>
            supabase.from('promotion_targets').insert(targetRows)
          );
          if (!insRes.ok) {
            logger.error('promotions.update_targets_insert_failed', {
              message: insRes.error.message,
            });
            await deactivatePromotionAfterPartialWrite(id);
            return insRes;
          }
        }
      }

      // Combo slots (delete-all-then-reinsert, mirrors the targets strategy
      // above) — only touched when the caller explicitly passes `slots`.
      if (slots !== undefined) {
        const slotsRes = await saveComboSlots(id, slots);
        if (!slotsRes.ok) {
          logger.error('promotions.update_combo_slots_failed', {
            message: slotsRes.error.message,
            promotionId: id,
          });
          return slotsRes;
        }
      }

      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidatePromotionQueries(queryClient);
    },
  });
}

/**
 * Real DELETE (not a soft-deactivate — see useMutationUpdatePromotion's doc
 * comment above). `order_items.promotion_id` is ON DELETE SET NULL (Plan 01),
 * so a sale that already used this promotion keeps its recorded discount
 * snapshot after deletion.
 */
export function useMutationDeletePromotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<Result<null>> => {
      const res = await supabaseMutation(() => supabase.from('promotions').delete().eq('id', id));
      if (!res.ok) {
        logger.error('promotions.delete_failed', { message: res.error.message });
        return res;
      }
      return ok(null);
    },
    onSuccess: result => {
      if (result.ok) invalidatePromotionQueries(queryClient);
    },
  });
}

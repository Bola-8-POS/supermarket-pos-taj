/**
 * Applies an approved price batch with the staff member's own session, through the same data path the product
 * dialog uses (`productUpdateToRow` + a products UPDATE), so RLS `products_update_manager_admin` stays the authority
 * (D-10). PostgREST cannot apply 25 different prices in one request, so items go one by one, each with a
 * compare-and-swap on `updated_at`: zero rows means someone else changed the product first (stale) and nothing is
 * overwritten. The batch is never retried; after the loop the server re-reads every price (assistant_finish) and its
 * per-item verdict, not this function's, is what the staff member sees.
 */
import { finishProposal } from '@entities/assistant';
import { productUpdateToRow } from '@entities/product';
import type { AssistantFinishResult, AssistantPreviewItem } from '@shared/lib/domain';
import type { AssistantError } from '@shared/lib/local-assistant/proposal';
import { logger } from '@shared/lib/logger-instance';
import type { Result } from '@shared/lib/result';
import { supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

type ItemState = 'applied' | 'stale' | 'error' | 'skipped';

export type PriceIo = {
  update: (productId: string, basePrice: number, expectedUpdatedAt: string) => Promise<'applied' | 'stale' | 'error'>;
  finish: (proposalId: string, outcome: Record<string, unknown>) => Promise<Result<AssistantFinishResult, AssistantError>>;
};

/** The real data path on `client` (the staff member's own session; a test passes another signed-in client). */
export const priceIo = (client: typeof supabase = supabase): PriceIo => ({
  async update(productId, basePrice, expectedUpdatedAt) {
    const row = productUpdateToRow({ basePrice });
    const res = await supabaseMutation(() =>
      client.from('products').update(row).eq('id', productId).eq('updated_at', expectedUpdatedAt).select('id')
    );
    if (!res.ok) {
      logger.warn('assistant.price.update_failed', { message: res.error.message });
      return 'error';
    }
    return res.data !== null && res.data.length > 0 ? 'applied' : 'stale';
  },
  finish: (proposalId, outcome) => finishProposal(proposalId, outcome, client),
});

export async function applyPriceBatch(
  proposalId: string,
  items: AssistantPreviewItem[],
  io: PriceIo = priceIo()
): Promise<Result<AssistantFinishResult, AssistantError>> {
  const outcome: { product_id: string; result: ItemState }[] = [];
  let halted = false;
  for (const item of items) {
    // A write error (network, RLS error) stops the loop: the rest is left untouched and the server reports it stale.
    if (halted || item.expected_updated_at === undefined) {
      outcome.push({ product_id: item.product_id, result: 'skipped' });
      continue;
    }
    const result = await io.update(item.product_id, item.after, item.expected_updated_at);
    if (result === 'error') halted = true;
    outcome.push({ product_id: item.product_id, result });
  }
  return io.finish(proposalId, { items: outcome });
}

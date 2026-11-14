import type { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '@entities/inventory';
import { invalidateCatalogQueries } from '@entities/product';
import type { AssistantReply, PreviewReply } from '@shared/lib/local-assistant/presenter';

/**
 * After an approval attempt, refresh the same caches the normal Products-page price edit
 * (`invalidateCatalogQueries`) and stock adjustment (`inventoryKeys`) refresh. Products are cached for 5 minutes and
 * the till prices carts from them, so without this a committed price change is not sold until the cache expires (WR-04).
 * Runs when the write committed (executed, partial) or may have (RESULT_UNCONFIRMED); a cancel or a clean refusal
 * changed nothing.
 */
export function invalidateAfterWrite(queryClient: QueryClient, preview: PreviewReply, reply: AssistantReply): void {
  const maybeWritten =
    (reply.type === 'outcome' && (reply.status === 'executed' || reply.status === 'partial')) ||
    (reply.type === 'refusal' && reply.code === 'RESULT_UNCONFIRMED');
  if (!maybeWritten) return;
  if (preview.kind === 'product.price') {
    invalidateCatalogQueries(queryClient);
    return;
  }
  void queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
  void queryClient.invalidateQueries({ queryKey: inventoryKeys.log() });
  for (const { product_id } of preview.items) {
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.product(product_id) });
  }
}

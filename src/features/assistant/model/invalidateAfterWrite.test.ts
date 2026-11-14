import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { inventoryKeys } from '@entities/inventory';
import type { AssistantReply, PreviewReply } from '@shared/lib/local-assistant/presenter';
import { invalidateAfterWrite } from './invalidateAfterWrite';

const PID = '11111111-1111-4111-8111-111111111111';
const item = { product_id: PID, name: 'Ghee', before: 10, after: 8 };
const preview = (kind: PreviewReply['kind']): PreviewReply => ({
  type: 'preview',
  kind,
  proposalId: '22222222-2222-4222-8222-222222222222',
  payloadHash: 'h',
  expiresInSeconds: 120,
  items: [item],
});
const outcome = (kind: PreviewReply['kind'], status: 'executed' | 'partial' | 'cancelled' | 'expired'): AssistantReply => ({
  type: 'outcome',
  kind,
  status,
  items: [item],
});

/** A client whose cached entries are all fresh, so `isInvalidated` shows exactly what the call invalidated. */
function seeded() {
  const qc = new QueryClient();
  const keys = {
    products: ['products'] as const,
    management: ['products', 'management'] as const,
    inventory: inventoryKeys.all,
    log: inventoryKeys.log(PID),
    product: inventoryKeys.product(PID),
  };
  for (const k of Object.values(keys)) qc.setQueryData([...k, 'x'], 1);
  const stale = (k: readonly unknown[]) => qc.getQueryState([...k, 'x'])?.isInvalidated === true;
  return { qc, keys, stale };
}

describe('invalidateAfterWrite (WR-04)', () => {
  it('a committed price change invalidates the catalog, as the Products page edit does', () => {
    const { qc, keys, stale } = seeded();
    invalidateAfterWrite(qc, preview('product.price'), outcome('product.price', 'executed'));
    expect(stale(keys.products)).toBe(true);
    expect(stale(keys.management)).toBe(true);
  });

  it('a partly applied price batch invalidates too (some prices are already written)', () => {
    const { qc, keys, stale } = seeded();
    invalidateAfterWrite(qc, preview('product.price'), outcome('product.price', 'partial'));
    expect(stale(keys.products)).toBe(true);
  });

  it('a committed stock change invalidates the inventory list, the product and the log, as a normal adjustment does', () => {
    const { qc, keys, stale } = seeded();
    invalidateAfterWrite(qc, preview('inventory.adjust'), outcome('inventory.adjust', 'executed'));
    expect(stale(keys.inventory)).toBe(true);
    expect(stale(keys.product)).toBe(true);
    expect(stale(keys.log)).toBe(true);
  });

  it('an unconfirmed result may have committed, so it refreshes the same caches', () => {
    const { qc, keys, stale } = seeded();
    invalidateAfterWrite(qc, preview('inventory.adjust'), { type: 'refusal', code: 'RESULT_UNCONFIRMED' });
    expect(stale(keys.inventory)).toBe(true);
  });

  it('a cancelled or expired preview, or a clean refusal, changed nothing and invalidates nothing', () => {
    const { qc, keys, stale } = seeded();
    invalidateAfterWrite(qc, preview('inventory.adjust'), outcome('inventory.adjust', 'cancelled'));
    invalidateAfterWrite(qc, preview('product.price'), outcome('product.price', 'expired'));
    invalidateAfterWrite(qc, preview('product.price'), { type: 'refusal', code: 'STOCK_CHANGED' });
    expect(Object.values(keys).some(stale)).toBe(false);
  });
});

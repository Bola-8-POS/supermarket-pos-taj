import { describe, expect, it, vi } from 'vitest';
import type { AssistantPreviewItem } from '@shared/lib/domain';
import { present } from '@shared/lib/local-assistant/presenter';
import { ok } from '@shared/lib/result';
import { applyPriceBatch, type PriceIo } from './applyPriceBatch';

const item = (n: number, over: Partial<AssistantPreviewItem> = {}): AssistantPreviewItem => ({
  product_id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  name: `Product ${String(n)}`,
  before: 10,
  after: 20 + n,
  expected_updated_at: `2026-11-08T10:00:0${String(n)}.123456+00:00`,
  ...over,
});

function makeIo(states: ('applied' | 'stale' | 'error')[]) {
  const update = vi.fn();
  for (const s of states) update.mockResolvedValueOnce(s);
  const finish = vi.fn().mockImplementation((_id: string, outcome: { items: { product_id: string; result: string }[] }) =>
    Promise.resolve(
      ok({
        ok: true,
        status: outcome.items.every(i => i.result === 'applied') ? 'executed' : 'partial',
        items: outcome.items.map(i => ({
          product_id: i.product_id,
          name: 'n',
          before: 10,
          after: 21,
          result: i.result === 'applied' ? 'applied' : 'stale',
        })),
      })
    )
  );
  return { update, finish, io: { update, finish } as unknown as PriceIo };
}

describe('applyPriceBatch', () => {
  it('writes sequentially with the approved price and the staged row version, then finishes once', async () => {
    const { io, update, finish } = makeIo(['applied', 'applied']);
    const res = await applyPriceBatch('p-1', [item(1), item(2)], io);
    expect(update.mock.calls).toEqual([
      [item(1).product_id, 21, item(1).expected_updated_at],
      [item(2).product_id, 22, item(2).expected_updated_at],
    ]);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith('p-1', {
      items: [
        { product_id: item(1).product_id, result: 'applied' },
        { product_id: item(2).product_id, result: 'applied' },
      ],
    });
    expect(res.ok && res.data.status).toBe('executed');
  });

  it('item 2 changed meanwhile: items 1 and 3 are applied, 2 is stale, finish gets all three, panel says 2 of 3 naming it', async () => {
    const { io, update, finish } = makeIo(['applied', 'stale', 'applied']);
    const res = await applyPriceBatch('p-1', [item(1), item(2), item(3)], io);
    expect(update).toHaveBeenCalledTimes(3);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[1]).toEqual({
      items: [
        { product_id: item(1).product_id, result: 'applied' },
        { product_id: item(2).product_id, result: 'stale' },
        { product_id: item(3).product_id, result: 'applied' },
      ],
    });
    if (!res.ok) throw new Error('expected the server verdict');
    const shown = present({
      type: 'outcome',
      kind: 'product.price',
      status: res.data.status,
      items: [
        { ...item(1), result: 'applied' },
        { ...item(2), result: 'stale' },
        { ...item(3), result: 'applied' },
      ],
    });
    expect(shown.key).toBe('assistant.result.partial');
    expect(shown.params).toEqual({ applied: 2, total: 3, names: 'Product 2' });
  });

  it('stops writing after a write error and leaves the rest untouched, still finishing so the server records it', async () => {
    const { io, update, finish } = makeIo(['applied', 'error']);
    await applyPriceBatch('p-1', [item(1), item(2), item(3)], io);
    expect(update).toHaveBeenCalledTimes(2);
    expect(finish.mock.calls[0]?.[1]).toEqual({
      items: [
        { product_id: item(1).product_id, result: 'applied' },
        { product_id: item(2).product_id, result: 'error' },
        { product_id: item(3).product_id, result: 'skipped' },
      ],
    });
  });

  it('never writes an item that has no staged row version', async () => {
    const { io, update, finish } = makeIo([]);
    await applyPriceBatch('p-1', [item(1, { expected_updated_at: undefined })], io);
    expect(update).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

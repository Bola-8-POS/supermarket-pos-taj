import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionContext } from '@shared/lib/telemetry';
import { cancelPendingAction, consumePendingAction, createPendingAction } from './pendingActions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const noopExecutor = vi.fn().mockResolvedValue({ ok: true, data: null });
const ctx = {} as AgentActionContext;

describe('pendingActions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a crypto.randomUUID()-shaped token, not the old Math.random() format', () => {
    const token = createPendingAction('close_tab', {}, undefined, noopExecutor);
    expect(token).toMatch(UUID_RE);
  });

  it('is single-use: a second consume of the same token returns null', () => {
    const token = createPendingAction('close_tab', { id: 'x' }, 'preview', noopExecutor);

    const first = consumePendingAction(token);
    expect(first?.toolName).toBe('close_tab');

    const second = consumePendingAction(token);
    expect(second).toBeNull();
  });

  it('consuming an unknown token returns null', () => {
    expect(consumePendingAction('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('expires after the TTL: a consume past 5 minutes returns null', () => {
    vi.useFakeTimers();
    const token = createPendingAction('deactivate_product', {}, undefined, noopExecutor);

    vi.advanceTimersByTime(5 * 60_000 + 1);

    expect(consumePendingAction(token)).toBeNull();
  });

  it('does not expire just under the TTL', () => {
    vi.useFakeTimers();
    const token = createPendingAction('deactivate_product', {}, undefined, noopExecutor);

    vi.advanceTimersByTime(5 * 60_000 - 1);

    expect(consumePendingAction(token)?.toolName).toBe('deactivate_product');
  });

  it('cancelPendingAction deletes the token so a later consume returns null', () => {
    const token = createPendingAction('bulk_import_products', {}, undefined, noopExecutor);

    expect(cancelPendingAction(token)).toBe(true);
    expect(consumePendingAction(token)).toBeNull();
  });

  // Sanity check the fixture executor type-checks against the real signature
  // (unused otherwise — every case above only exercises the token lifecycle).
  it('stores the executor and args unchanged for the caller to invoke', () => {
    const args = { productId: 'p1' };
    const token = createPendingAction('deactivate_product', args, 'Deactivate p1', noopExecutor);

    const action = consumePendingAction(token);
    expect(action?.args).toBe(args);
    expect(action?.preview).toBe('Deactivate p1');
    void action?.executor(args, ctx);
    expect(noopExecutor).toHaveBeenCalledWith(args, ctx);
  });
});

/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked handles on the mocked client, and Storage.prototype is patched and restored */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { fetchStoreSwitchState, reportTillSync } from './client';

// test-setup.ts replaces the supabase client with a mock; each test shapes the two calls it needs.
const from = vi.mocked(supabase.from);
const rpc = vi.mocked(supabase.rpc);

function view(result: { data: unknown; error: { message: string } | null }) {
  from.mockReturnValue({ select: () => ({ maybeSingle: () => Promise.resolve(result) }) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStoreSwitchState', () => {
  it.each(['active', 'draining', 'frozen', 'moved'] as const)('returns %s', async state => {
    view({ data: { state }, error: null });
    expect(await fetchStoreSwitchState()).toBe(state);
    expect(from).toHaveBeenCalledWith('store_switch_status');
  });

  it('is unknown (null) for an error, a missing view, an unknown state or an exception', async () => {
    view({ data: null, error: { message: 'relation "store_switch_status" does not exist' } });
    expect(await fetchStoreSwitchState()).toBeNull();
    view({ data: null, error: null });
    expect(await fetchStoreSwitchState()).toBeNull();
    view({ data: { state: 'exploded' }, error: null });
    expect(await fetchStoreSwitchState()).toBeNull();
    from.mockImplementation(() => {
      throw new Error('offline');
    });
    expect(await fetchStoreSwitchState()).toBeNull();
  });
});

describe('reportTillSync', () => {
  it('sends the report with this till identity and returns the state it learned', async () => {
    rpc.mockResolvedValue({ data: 'draining', error: null } as never);
    const next = await reportTillSync({ queueDepth: 3, deadLetterDepth: 1, seenState: 'active' });
    expect(next).toBe('draining');
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe('report_till_sync');
    expect(args).toMatchObject({
      p_queue_depth: 3,
      p_dead_letter_depth: 1,
      p_seen_state: 'active',
    });
    expect(String(args['p_terminal_uuid']).length).toBeGreaterThanOrEqual(8);
    expect(String(args['p_terminal_label'])).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('is null when the server refuses or answers nonsense', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } } as never);
    expect(
      await reportTillSync({ queueDepth: 0, deadLetterDepth: 0, seenState: 'active' })
    ).toBeNull();
    rpc.mockResolvedValue({ data: 'banana', error: null } as never);
    expect(
      await reportTillSync({ queueDepth: 0, deadLetterDepth: 0, seenState: 'active' })
    ).toBeNull();
  });
});

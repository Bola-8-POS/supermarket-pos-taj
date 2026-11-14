import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalModel } from './model';
import { buildMessages } from './prompt';
import { proposalJsonSchema } from './proposal';

const w = window as unknown as Record<string, unknown>;

describe('createLocalModel', () => {
  beforeEach(() => {
    w['__TAURI_INTERNALS__'] = {};
  });
  afterEach(() => {
    delete w['__TAURI_INTERNALS__'];
  });

  it('passes requestId, messages and the proposal schema to assistant_infer', async () => {
    const invokeFn = vi.fn().mockResolvedValue('{"kind":"refuse","reason":"unsupported"}');
    const messages = buildMessages('price of ghee');
    const res = await createLocalModel(invokeFn).propose(messages);
    expect(res).toEqual({ ok: true, data: '{"kind":"refuse","reason":"unsupported"}' });
    expect(invokeFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe('assistant_infer');
    expect(args['messages']).toBe(messages);
    expect(args['schema']).toBe(proposalJsonSchema);
    expect(typeof args['requestId']).toBe('string');
  });

  it('cancels with the same requestId when the signal aborts', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let rejectInfer: (e: unknown) => void = () => undefined;
    const invokeFn = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === 'assistant_infer') return new Promise((_res, rej) => (rejectInfer = rej));
      return Promise.resolve(null);
    });
    const ctrl = new AbortController();
    const pending = createLocalModel(invokeFn).propose(buildMessages('x'), ctrl.signal);
    ctrl.abort();
    rejectInfer('CANCELLED');
    const res = await pending;
    expect(res.ok).toBe(false);
    const infer = calls.find(c => c[0] === 'assistant_infer');
    const cancel = calls.find(c => c[0] === 'assistant_cancel');
    expect(cancel?.[1]?.['requestId']).toBe(infer?.[1]?.['requestId']);
  });

  it.each([
    ['TIMEOUT', 'MODEL_TIMEOUT'],
    ['BUSY', 'MODEL_UNAVAILABLE'],
    ['MEMORY_PRESSURE', 'MODEL_UNAVAILABLE'],
    ['NOT_READY', 'MODEL_UNAVAILABLE'],
    ['BAD_RESPONSE', 'INVALID_PROPOSAL'],
  ])('maps bridge code %s to %s', async (bridge, code) => {
    const res = await createLocalModel(vi.fn().mockRejectedValue(bridge)).propose(buildMessages('x'));
    expect(res).toEqual({ ok: false, error: { code } });
  });

  it('treats a non-string reply as an invalid proposal', async () => {
    const res = await createLocalModel(vi.fn().mockResolvedValue({ a: 1 })).propose(buildMessages('x'));
    expect(res).toEqual({ ok: false, error: { code: 'INVALID_PROPOSAL' } });
  });

  it('returns MODEL_UNAVAILABLE without calling invoke outside Tauri', async () => {
    delete w['__TAURI_INTERNALS__'];
    const invokeFn = vi.fn();
    const res = await createLocalModel(invokeFn).propose(buildMessages('x'));
    expect(res).toEqual({ ok: false, error: { code: 'MODEL_UNAVAILABLE' } });
    expect((await createLocalModel(invokeFn).status()).state).toBe('unavailable');
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it('parses the status payload and falls back to unavailable when it is malformed', async () => {
    const good = { state: 'ready', reason: null, modelId: 'm', runtimeTag: 't' };
    expect(await createLocalModel(vi.fn().mockResolvedValue(good)).status()).toEqual(good);
    expect((await createLocalModel(vi.fn().mockResolvedValue({ state: 'bogus' })).status()).state).toBe('unavailable');
    expect((await createLocalModel(vi.fn().mockRejectedValue('x')).status()).state).toBe('unavailable');
  });
});

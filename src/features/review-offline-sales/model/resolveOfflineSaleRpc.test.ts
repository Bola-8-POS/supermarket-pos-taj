/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

type Reply = { data: unknown; error: unknown; status?: number };
const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Reply>>());
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { callResolveOfflineSale, type ResolveOfflineSaleInput } from './resolveOfflineSaleRpc';

const MANAGER = '77777777-7777-4777-8777-777777777777';
const TAB = '66666666-6666-4666-8666-666666666666';
const MODIFIER = '99999999-9999-4999-8999-999999999999';
const good = {
  data: { ok: true, outcome: 'already_recorded', tabId: TAB, approverId: MANAGER, auditId: 'x', idempotent: true },
  error: null,
  status: 200,
};

const input = (overrides: Partial<ResolveOfflineSaleInput> = {}): ResolveOfflineSaleInput => ({
  intent: 'write_off',
  record: makeSale({ status: 'needs_review' }),
  trusted: true,
  reason: '  Customer left, cash recorded by hand  ',
  approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-000000000001',
  approverId: MANAGER,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockReset();
});

describe('callResolveOfflineSale', () => {
  it('sends the goods with modifiers and weight, the recorded tab and the intent, and parses the answer', async () => {
    const base = makeSale({ status: 'needs_review', tabId: TAB });
    const record = {
      ...base,
      request: {
        ...base.request,
        items: [{ ...base.request.items[0]!, modifierIds: [MODIFIER], weightGrams: 750 }],
      },
    };
    rpc.mockResolvedValueOnce(good);

    const res = await callResolveOfflineSale(input({ intent: 'review', record }));

    expect(res).toEqual({
      ok: true,
      data: { outcome: 'already_recorded', tabId: TAB, approverId: MANAGER, idempotent: true, amountShort: 0 },
    });
    const [name, args] = rpc.mock.calls[0] ?? [];
    expect(name).toBe('resolve_offline_sale');
    expect(args).toMatchObject({
      p_intent: 'review',
      p_recorded_tab_id: TAB,
      p_lines: [{ quantity: 2, modifier_ids: [MODIFIER], weight_grams: 750 }],
      p_reason: 'Customer left, cash recorded by hand',
    });
  });

  it('reads the server amount on a link answer and ignores it on any other outcome', async () => {
    rpc.mockResolvedValueOnce({ ...good, data: { ...good.data, serverAmount: 8.5 } });
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: true, data: { serverAmount: 8.5 } });

    rpc.mockResolvedValueOnce({ ...good, data: { ...good.data, outcome: 'proceed', serverAmount: 8.5 } });
    const other = await callResolveOfflineSale(input());
    expect(other.ok && other.data.serverAmount).toBeUndefined();
  });

  it('sends no reason when there is none', async () => {
    rpc.mockResolvedValueOnce(good);
    await callResolveOfflineSale(input({ intent: 'rering', reason: undefined }));
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_reason: null });
  });

  it('retries a thrown call once and gives up after the second failure', async () => {
    rpc.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(good);
    expect((await callResolveOfflineSale(input())).ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);

    rpc.mockReset();
    rpc.mockRejectedValue(new Error('network'));
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not retry a database error', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22P02', message: 'bad' }, status: 400 });
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: false, error: { code: 'SUPABASE_ERROR' } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('reads an unknown outcome name or a missing approver as an answer it cannot trust', async () => {
    for (const data of [
      { ok: true, outcome: 'surprise', approverId: MANAGER, idempotent: false },
      { ok: true, outcome: 'written_off', idempotent: false },
      'garbage',
      null,
    ]) {
      rpc.mockResolvedValueOnce({ data, error: null, status: 200 });
      expect(await callResolveOfflineSale(input())).toMatchObject({
        ok: false,
        error: { code: 'SERVER_UPDATE_REQUIRED' },
      });
    }
  });
  it('a server mismatch tells the manager to write the sale off', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'SERVER_MISMATCH: held_goods' }, status: 400 });
    const res = await callResolveOfflineSale(input({ intent: 'rering' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/written off|dar de baja/i) } });
  });

  it('a lost answer does not claim nothing was changed', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' }, status: 0 });
    const res = await callResolveOfflineSale(input());
    expect(!res.ok && res.error.message).not.toMatch(/nothing was changed|ningún cambio/i);
  });

  it('an unknown outcome tells the manager to write the sale off', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' }, status: 0 });
    const res = await callResolveOfflineSale(input({ intent: 'write_off' }));
    expect(res).toMatchObject({ ok: false, error: { detail: 'OUTCOME_UNKNOWN', message: expect.stringMatching(/write off|dar de baja/i) } });
  });

  it('a lost re-ring answer tells the manager to try again', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' }, status: 0 });
    const res = await callResolveOfflineSale(input({ intent: 'rering' }));
    expect(res).toMatchObject({ ok: false, error: { detail: 'OUTCOME_UNKNOWN', message: expect.stringMatching(/nothing was changed|no se cambió nada/i) } });
    expect(!res.ok && res.error.message).not.toMatch(/write off|dar de baja/i);
  });

  it('a failure before anything was sent says nothing was changed', async () => {
    // a lost review call is safe to repeat; an answered refusal is final
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' }, status: 0 });
    const lost = await callResolveOfflineSale(input({ intent: 'review' }));
    expect(!lost.ok && lost.error.message).toMatch(/nothing was changed|no se cambió nada/i);
    expect(!lost.ok && lost.error.message).not.toMatch(/write off|dar de baja/i);
    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: { ok: false, code: 'VALIDATION_ERROR' }, error: null, status: 200 });
    const refused = await callResolveOfflineSale(input());
    expect(!refused.ok && refused.error.message).toMatch(/nothing was changed|no se cambió nada/i);
  });

  it('a sale the server already wrote off cannot be re-rung', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, code: 'ALREADY_WRITTEN_OFF' }, error: null, status: 200 });
    const res = await callResolveOfflineSale(input({ intent: 'rering' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/wrote this sale off|dio de baja/i) } });
  });
});

describe('the link answer duplicateReringTabId', () => {
  it('is read when the server links the original over a paid re-ring, and absent otherwise', async () => {
    const dup = '7a6b5c4d-1111-4222-8333-444455556666';
    rpc.mockResolvedValueOnce({ ...good, data: { ...good.data, duplicateReringTabId: dup } });
    expect(await callResolveOfflineSale(input({ intent: 'write_off' }))).toMatchObject({ ok: true, data: { duplicateReringTabId: dup } });
    rpc.mockResolvedValueOnce(good);
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: true, data: { duplicateReringTabId: undefined } });
  });
});

describe('the link answer amountShort', () => {
  it('is read when sent, and defaults to 0 from an older server', async () => {
    rpc.mockResolvedValueOnce({ ...good, data: { ...good.data, amountShort: 3.25 } });
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: true, data: { amountShort: 3.25 } });
    rpc.mockResolvedValueOnce(good);
    expect(await callResolveOfflineSale(input())).toMatchObject({ ok: true, data: { amountShort: 0 } });
  });
});

describe('a write-off over a re-ring the server already holds paid', () => {
  it('a write-off raising RERING_ALREADY_PAID shows its own copy and changes nothing locally', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'RERING_ALREADY_PAID: this sale was already re-rung' }, status: 400 });
    const res = await callResolveOfflineSale(input({ intent: 'write_off' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/paid re-ring|nuevo cobro/i) } });
    // not the serverMismatch text, and no detail that would flag a lost write-off answer
    expect(!res.ok && res.error.message).not.toMatch(/can only be written off|solo se puede dar de baja/i);
    expect(!res.ok && res.error.detail).toBeUndefined();
  });
});

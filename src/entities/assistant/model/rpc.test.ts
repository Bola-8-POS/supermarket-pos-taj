import { describe, expect, it, vi } from 'vitest';
import type { supabase } from '@shared/lib/supabase';
import {
  approveProposal,
  assistantGate,
  cancelProposal,
  recordRejection,
  stageProposal,
  type StageInput,
} from './rpc';

type Client = typeof supabase;

const PID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';

/** Stand-in for supabase.rpc: records every call and answers with the queued response. */
function fakeClient(response: { data: unknown; error: { message: string } | null } | Error) {
  const rpc = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  return { client: { rpc } as unknown as Client, rpc };
}

const STAGE: StageInput = {
  kind: 'inventory.adjust',
  reason: 'waste',
  items: [{ product_id: PID, delta: -2, expected_quantity: 10 }],
  terminalId: 'T1',
  model: 'm@r',
  policyVersion: 'p1',
  promptVersion: 'q1',
  rawText: 'write off 2 ghee',
};

const stagedOk = {
  ok: true,
  proposal_id: PROPOSAL,
  payload_hash: 'abc',
  expires_at: '2026-11-08T12:00:00Z',
  expires_in_seconds: 120,
  items: [{ product_id: PID, name: 'Ghee', before: 10, after: 8 }],
};

describe('stageProposal', () => {
  it('passes the batch to assistant_stage and returns the server preview', async () => {
    const { client, rpc } = fakeClient({ data: stagedOk, error: null });
    const res = await stageProposal(STAGE, client);
    expect(rpc).toHaveBeenCalledWith('assistant_stage', {
      p_kind: 'inventory.adjust',
      p_items: STAGE.items,
      p_reason: 'waste',
      p_terminal_id: 'T1',
      p_model: 'm@r',
      p_policy_version: 'p1',
      p_prompt_version: 'q1',
      p_raw_text: 'write off 2 ghee',
    });
    expect(res.ok && res.data.items).toEqual(stagedOk.items);
  });

  it('turns a coded refusal into the matching AssistantCode', async () => {
    const { client } = fakeClient({ data: { ok: false, code: 'STALE_TARGET' }, error: null });
    const res = await stageProposal(STAGE, client);
    expect(!res.ok && res.error.code).toBe('STALE_TARGET');
  });

  it('maps a code the client does not know to DATA_UNAVAILABLE (fail closed)', async () => {
    const { client } = fakeClient({ data: { ok: false, code: 'SOMETHING_NEW' }, error: null });
    const res = await stageProposal(STAGE, client);
    expect(!res.ok && res.error.code).toBe('DATA_UNAVAILABLE');
  });

  it.each([
    ['a supabase error', { data: null, error: { message: 'boom' } }],
    ['a stage result without the server TTL', { data: { ...stagedOk, expires_in_seconds: undefined }, error: null }],
    ['an unparseable payload', { data: { ok: true, proposal_id: 'not-a-uuid' }, error: null }],
    ['a null payload', { data: null, error: null }],
  ])('treats %s as DATA_UNAVAILABLE', async (_name, response) => {
    const { client } = fakeClient(response);
    const res = await stageProposal(STAGE, client);
    expect(!res.ok && res.error.code).toBe('DATA_UNAVAILABLE');
  });

  it('treats a thrown transport error as DATA_UNAVAILABLE', async () => {
    const { client } = fakeClient(new Error('network down'));
    const res = await stageProposal(STAGE, client);
    expect(!res.ok && res.error.code).toBe('DATA_UNAVAILABLE');
  });
});

describe('approveProposal', () => {
  const input = { proposalId: PROPOSAL, payloadHash: 'abc', approvalId: PID, approverId: PID, terminalId: 'T1' };

  it('sends every binding and returns the executed items', async () => {
    const items = [{ product_id: PID, name: 'Ghee', before: 10, after: 8 }];
    const { client, rpc } = fakeClient({ data: { ok: true, status: 'executed', items }, error: null });
    const res = await approveProposal(input, client);
    expect(rpc).toHaveBeenCalledWith('assistant_approve', {
      p_proposal_id: PROPOSAL,
      p_payload_hash: 'abc',
      p_approval_id: PID,
      p_approver_id: PID,
      p_terminal_id: 'T1',
    });
    expect(res.ok && res.data.status).toBe('executed');
  });

  it('keeps a known refusal code and falls back to EXECUTION_FAILED for an unknown one', async () => {
    const known = await approveProposal(input, fakeClient({ data: { ok: false, code: 'STOCK_CHANGED' }, error: null }).client);
    expect(!known.ok && known.error.code).toBe('STOCK_CHANGED');
    const unknown = await approveProposal(input, fakeClient({ data: { ok: false, code: 'IDEMPOTENCY_KEY_INVALID' }, error: null }).client);
    expect(!unknown.ok && unknown.error.code).toBe('EXECUTION_FAILED');
  });

  // WR-03: the stock write runs inside this one RPC. If the response is lost the write may have committed, so
  // "try again" (DATA_UNAVAILABLE) would write the stock off twice; the staff are told to check first.
  it.each([
    ['a supabase error', { data: null, error: { message: 'timeout' } }],
    ['a thrown fetch', new Error('Failed to fetch')],
    ['an unparseable body', { data: { ok: true, status: 'executed' }, error: null }],
    ['a null body', { data: null, error: null }],
  ])('treats %s as RESULT_UNCONFIRMED, never DATA_UNAVAILABLE', async (_name, response) => {
    const res = await approveProposal(input, fakeClient(response).client);
    expect(!res.ok && res.error.code).toBe('RESULT_UNCONFIRMED');
  });
});

describe('assistantGate, cancelProposal, recordRejection', () => {
  it('returns the lock state', async () => {
    const { client } = fakeClient({ data: { ok: true, locked: true, until: '2026-11-08T12:10:00Z' }, error: null });
    const res = await assistantGate(client);
    expect(res.ok && res.data.locked).toBe(true);
  });

  it('cancel sends the reason', async () => {
    const { client, rpc } = fakeClient({ data: { ok: true, status: 'expired' }, error: null });
    await cancelProposal(PROPOSAL, 'expired', client);
    expect(rpc).toHaveBeenCalledWith('assistant_cancel', { p_proposal_id: PROPOSAL, p_reason: 'expired' });
  });

  it('recordRejection sends a lower-case code and the kind, never text', async () => {
    const { client, rpc } = fakeClient({ data: { ok: true, locked: false }, error: null });
    await recordRejection('MODEL_REFUSED_UNSAFE', 'refuse', client);
    expect(rpc).toHaveBeenCalledWith('assistant_record_rejection', { p_reason: 'model_refused_unsafe', p_kind: 'refuse' });
    await recordRejection('INVALID_PROPOSAL', null, client);
    expect(rpc).toHaveBeenLastCalledWith('assistant_record_rejection', { p_reason: 'invalid_proposal' });
  });
});

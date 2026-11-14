/**
 * Result<T>-returning wrappers for the assistant write contract (migration 20261108000002). The server owns the
 * decision: every refusal arrives as `{ ok: false, code }` and is classified by code here. A Supabase error or a
 * payload that does not parse is DATA_UNAVAILABLE (fail closed), never a guess.
 */
/* eslint-disable i18next/no-literal-string -- RPC op names for logs and rpc function names, not UI copy */
import type { z } from 'zod';
import {
  AssistantApproveResultSchema,
  AssistantFinishResultSchema,
  AssistantGateSchema,
  AssistantSimpleResultSchema,
  AssistantStageResultSchema,
  type AssistantApproveResult,
  type AssistantFinishResult,
  type AssistantGate,
  type AssistantStageResult,
} from '@shared/lib/domain';
import {
  AssistantCodeSchema,
  type AssistantCode,
  type AssistantError,
} from '@shared/lib/local-assistant/proposal';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

type Client = typeof supabase;

export type StageItem = { product_id: string; delta: number; expected_quantity: number };
/** `price` is in currency units (cents / 100); `expected_*` are the values the staff member saw, compared on the server. */
export type PriceStageItem = {
  product_id: string;
  price: number;
  expected_price: number;
  expected_updated_at: string;
};

type StageBase = {
  terminalId: string;
  /** `modelId@runtimeTag` of the model that proposed this batch. */
  model: string;
  policyVersion: string;
  promptVersion: string;
  /** The screened user text; stored server-side in an admin-only table (D-17). */
  rawText: string;
};

export type StageInput = StageBase &
  (
    | { kind: 'inventory.adjust'; reason: string; items: StageItem[] }
    /** The server takes any `[a-z_]{1,40}` reason for a price batch; the gateway sends PRICE_REASON. */
    | { kind: 'product.price'; reason: string; items: PriceStageItem[] }
  );

export type ApproveInput = {
  proposalId: string;
  payloadHash: string;
  approvalId: string;
  approverId: string;
  terminalId: string;
};

const unavailable = (code: AssistantCode): Result<never, AssistantError> => err({ code });

/** Server code -> AssistantCode; a code the client does not know falls back to `fallback`. */
function toCode(code: string, fallback: AssistantCode): AssistantCode {
  const parsed = AssistantCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : fallback;
}

function settle<S extends z.ZodType<{ ok: boolean }>>(
  op: string,
  res: { data: unknown; error: { message: string } | null },
  schema: S,
  unknownCode: AssistantCode,
  failCode: AssistantCode = 'DATA_UNAVAILABLE'
): Result<Extract<z.infer<S>, { ok: true }>, AssistantError> {
  if (res.error) {
    logger.warn('assistant.rpc.failed', { op, message: res.error.message });
    return unavailable(failCode);
  }
  const parsed = schema.safeParse(res.data);
  if (!parsed.success) {
    logger.warn('assistant.rpc.unparseable', { op });
    return unavailable(failCode);
  }
  const value = parsed.data as { ok: boolean; code?: string };
  if (!value.ok) return err({ code: toCode(value.code ?? '', unknownCode) });
  return ok(value as Extract<z.infer<S>, { ok: true }>);
}

async function guarded<T>(
  op: string,
  run: () => Promise<Result<T, AssistantError>>,
  failCode: AssistantCode = 'DATA_UNAVAILABLE'
): Promise<Result<T, AssistantError>> {
  try {
    return await run();
  } catch (e) {
    logger.warn('assistant.rpc.failed', { op, message: e instanceof Error ? e.message : 'unknown' });
    return unavailable(failCode);
  }
}

export function assistantGate(client: Client = supabase): Promise<Result<AssistantGate, AssistantError>> {
  return guarded('gate', async () => settle('gate', await client.rpc('assistant_gate'), AssistantGateSchema, 'DATA_UNAVAILABLE'));
}

export function stageProposal(
  input: StageInput,
  client: Client = supabase
): Promise<Result<AssistantStageResult, AssistantError>> {
  return guarded('stage', async () =>
    settle(
      'stage',
      await client.rpc('assistant_stage', {
        p_kind: input.kind,
        p_items: input.items,
        p_reason: input.reason,
        p_terminal_id: input.terminalId,
        p_model: input.model,
        p_policy_version: input.policyVersion,
        p_prompt_version: input.promptVersion,
        p_raw_text: input.rawText,
      }),
      AssistantStageResultSchema,
      'DATA_UNAVAILABLE'
    )
  );
}

/**
 * A transport error, a throw or an unparseable body is RESULT_UNCONFIRMED, not DATA_UNAVAILABLE: the server may have
 * committed the write before the response was lost, and "try again" would then write it off twice (WR-03).
 */
export function approveProposal(
  input: ApproveInput,
  client: Client = supabase
): Promise<Result<AssistantApproveResult, AssistantError>> {
  return guarded('approve', async () =>
    settle(
      'approve',
      await client.rpc('assistant_approve', {
        p_proposal_id: input.proposalId,
        p_payload_hash: input.payloadHash,
        p_approval_id: input.approvalId,
        p_approver_id: input.approverId,
        p_terminal_id: input.terminalId,
      }),
      AssistantApproveResultSchema,
      'EXECUTION_FAILED',
      'RESULT_UNCONFIRMED'
    ),
    'RESULT_UNCONFIRMED'
  );
}

/** Plan 29-05 applies price changes on the client, then asks the server to verify what really happened. */
export function finishProposal(
  proposalId: string,
  outcome: Record<string, unknown>,
  client: Client = supabase
): Promise<Result<AssistantFinishResult, AssistantError>> {
  return guarded('finish', async () =>
    settle(
      'finish',
      await client.rpc('assistant_finish', { p_proposal_id: proposalId, p_outcome: outcome as never }),
      AssistantFinishResultSchema,
      'EXECUTION_FAILED'
    )
  );
}

export function cancelProposal(
  proposalId: string,
  reason: 'user' | 'expired',
  client: Client = supabase
): Promise<Result<{ status?: string | undefined }, AssistantError>> {
  return guarded('cancel', async () =>
    settle(
      'cancel',
      await client.rpc('assistant_cancel', { p_proposal_id: proposalId, p_reason: reason }),
      AssistantSimpleResultSchema,
      'DATA_UNAVAILABLE'
    )
  );
}

/**
 * Reports a refusal the client decided itself so the server cool-down (D-15) can count it. Codes returned by
 * stage/approve are already recorded server-side and must not be sent here. Only a code and a kind leave the
 * renderer, never text.
 */
export function recordRejection(
  code: AssistantCode,
  kind: string | null,
  client: Client = supabase
): Promise<Result<{ locked?: boolean | undefined }, AssistantError>> {
  return guarded('reject', async () =>
    settle(
      'reject',
      await client.rpc('assistant_record_rejection', {
        p_reason: code.toLowerCase(),
        ...(kind === null ? {} : { p_kind: kind }),
      }),
      AssistantSimpleResultSchema,
      'DATA_UNAVAILABLE'
    )
  );
}

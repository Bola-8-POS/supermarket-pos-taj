import { z } from 'zod';
import { clipAuditText, offlineSaleTotal, type OfflineSale } from '@entities/offline-sale';
import { UuidSchema } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type AppErrorCode, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
/* eslint-disable i18next/no-literal-string -- RPC name, parameter names, server codes and log events, not UI copy. */

/**
 * Two-mode Plan 02c, Task 3: the client side of `resolve_offline_sale`. The server spends the
 * approval ticket, looks the sale up as definer and writes the audit row in one transaction; the
 * client only sends what the till knows and reads the answer. A missing function or an answer it
 * cannot read is never a reason to write anything itself (Ruling 10).
 */

/** What the RPC may answer with `ok: true`. */
const OUTCOMES = ['written_off', 'already_recorded', 'already_rerung', 'proceed', 'moved_to_review'] as const;

const AnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    outcome: z.enum(OUTCOMES),
    tabId: UuidSchema.optional(),
    approverId: UuidSchema,
    idempotent: z.boolean(),
    // only the two link outcomes carry it, and a row written before it existed has none
    serverAmount: z.number().nonnegative().optional(),
    // how much less the linked server sale holds than the offline sale; an older server sends none
    amountShort: z.number().nonnegative().default(0),
    // the re-ring tab that also reached the server when the answer links the ORIGINAL sale
    duplicateReringTabId: UuidSchema.optional(),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

export type ResolveServerAnswer = {
  outcome: (typeof OUTCOMES)[number];
  tabId: string | undefined;
  approverId: string;
  idempotent: boolean;
  /** What the linked server sale charged (2 dp); only on a link outcome, and absent on an old replayed row. */
  serverAmount: number | undefined;
  /** How much less the linked server sale holds than the offline sale (0 when it covers it or on an old server). */
  amountShort: number;
  /** The paid re-ring that also reached the server (the answer links the original); a manager refunds it. */
  duplicateReringTabId: string | undefined;
};

export interface ResolveOfflineSaleInput {
  intent: 'write_off' | 'rering' | 'review';
  record: OfflineSale;
  /** False when the record's digest no longer matches: the key (and attempt keys) are not sent. */
  trusted: boolean;
  reason: string | undefined;
  approvalId: string;
  approverId: string;
}

const REASON_MAX_LENGTH = 500;

/** The generated argument types do not allow null; the function takes it for these. */
const nullable = <T>(value: T | null): T => value as T;

function buildArgs(input: ResolveOfflineSaleInput) {
  const { record, trusted } = input;
  const request = record.request;
  const reason = input.reason?.trim();
  return {
    p_intent: input.intent,
    p_sale_id: record.id,
    p_idempotency_key: nullable(trusted ? request.idempotencyKey : null),
    p_rering_keys: trusted ? [...record.reRingAttemptKeys] : [],
    p_lines: request.items.map(item => ({
      product_id: item.productId,
      quantity: item.quantity,
      modifier_ids: [...item.modifierIds],
      weight_grams: item.weightGrams ?? null,
    })),
    p_seller_id: record.staffId,
    p_recorded_tab_id: nullable(record.tabId ?? null),
    // the server never saw the sale: all of this is stored as a claim, none of it decides anything
    p_claim: {
      total: offlineSaleTotal(record) ?? null,
      soldAt: record.soldAt,
      receiptNumber: record.receiptNumber,
      terminalId: request.terminalId ?? null,
      lastCode: record.lastCode ?? null,
      keyUntrusted: !trusted,
    },
    p_reason: nullable(reason === undefined || reason === '' ? null : clipAuditText(reason, REASON_MAX_LENGTH)),
    p_approval_id: input.approvalId,
    p_approver_id: input.approverId,
  };
}

type RawReply = {
  data: unknown;
  error: { code?: string; message?: string } | null;
  status?: number;
};

/** `detail` of a failure that says nothing about whether the server committed the call. */
export const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN';

/** `detail` of the refusal that says the server already holds a write-off of this sale. */
export const ALREADY_WRITTEN_OFF = 'ALREADY_WRITTEN_OFF';

const fail = (code: AppErrorCode, key: string, detail?: string): Result<never> =>
  err({
    code,
    message: i18n.t(`featOrders:reviewOfflineSales.${key}`),
    ...(detail === undefined ? {} : { detail }),
  });

/** A function the database does not have: the client is ahead of the server. */
const isMissing = (reply: RawReply | undefined): boolean =>
  reply?.error?.code === 'PGRST202' || reply?.status === 404;

/** A reply that says nothing about whether the function ran: thrown, 5xx, or an error without a database code. */
const isTransportFailure = (reply: RawReply | undefined): boolean =>
  reply === undefined || (reply.error !== null && (!reply.error.code || (reply.status ?? 0) >= 500));

async function send(args: ReturnType<typeof buildArgs>): Promise<RawReply | undefined> {
  try {
    return (await supabase.rpc('resolve_offline_sale', args)) as RawReply;
  } catch (e) {
    logger.warn('offline_sale.resolve_rpc_threw', { error: e });
    return undefined;
  }
}

/**
 * Asks the server to resolve an offline sale. One retry, with the same arguments, when the reply is
 * lost (the server answers a repeat from its audit row, so a retry cannot spend a second ticket).
 */
export async function callResolveOfflineSale(
  input: ResolveOfflineSaleInput
): Promise<Result<ResolveServerAnswer>> {
  const args = buildArgs(input);
  let reply = await send(args);
  if (!isMissing(reply) && isTransportFailure(reply)) reply = await send(args);

  if (isMissing(reply)) return fail('SERVER_UPDATE_REQUIRED', 'serverUpdateRequired');
  if (reply === undefined || isTransportFailure(reply)) {
    logger.warn('offline_sale.resolve_rpc_unreachable', { saleId: input.record.id });
    // a lost review or re-ring call is safe to repeat (neither can commit a write-off); only a write-off is settled by writing the sale off
    return fail('SUPABASE_ERROR', input.intent === 'write_off' ? 'serverOutcomeUnknown' : 'serverCheckFailed', OUTCOME_UNKNOWN);
  }
  const { error } = reply;
  if (error) {
    const message = error.message ?? '';
    if (message.startsWith('AUTH_REQUIRED')) return fail('AUTH_REQUIRED', 'notSignedIn');
    if (message.startsWith('FORBIDDEN')) return fail('AUTH_FORBIDDEN', 'approvalRejected');
    // the sale was in fact re-rung and paid: it cannot be written off, and nothing changes locally
    if (message.startsWith('RERING_ALREADY_PAID')) return fail('VALIDATION_ERROR', 'reRingAlreadyPaid');
    if (message.startsWith('SERVER_MISMATCH')) return fail('VALIDATION_ERROR', 'serverMismatch');
    logger.warn('offline_sale.resolve_rpc_failed', { saleId: input.record.id, code: error.code });
    return fail('SUPABASE_ERROR', 'serverCheckFailed');
  }
  const parsed = AnswerSchema.safeParse(reply.data);
  if (!parsed.success) {
    logger.warn('offline_sale.resolve_rpc_unexpected_answer', { saleId: input.record.id });
    return fail('SERVER_UPDATE_REQUIRED', 'serverUpdateRequired', OUTCOME_UNKNOWN);
  }
  const answer = parsed.data;
  if (!answer.ok) {
    if (answer.code === 'ALREADY_WRITTEN_OFF') return fail('VALIDATION_ERROR', 'alreadyWrittenOff', ALREADY_WRITTEN_OFF);
    return answer.code === 'VALIDATION_ERROR'
      ? fail('VALIDATION_ERROR', 'serverCheckFailed')
      : fail('AUTH_FORBIDDEN', 'approvalRejected');
  }
  return ok({
    outcome: answer.outcome,
    tabId: answer.tabId,
    approverId: answer.approverId,
    idempotent: answer.idempotent,
    serverAmount:
      answer.outcome === 'already_recorded' || answer.outcome === 'already_rerung'
        ? answer.serverAmount
        : undefined,
    amountShort: answer.amountShort,
    duplicateReringTabId: answer.duplicateReringTabId,
  });
}

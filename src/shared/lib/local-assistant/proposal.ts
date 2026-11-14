/**
 * Strict proposal union the local model may emit (AI-SPEC §4b). The model output is untrusted text:
 * `parseProposal` is the only door, and any failure is null (no repair retry, no partial result).
 * Pure module: only zod is imported so the Plan 29-07 tsx harness can load it.
 */
import { z } from 'zod';

export const AssistantCodeSchema = z.enum([
  'INVALID_PROPOSAL',
  'MODEL_REFUSED_UNSUPPORTED',
  'MODEL_REFUSED_UNSAFE',
  'MODEL_REFUSED_AMBIGUOUS',
  'INPUT_TOO_LONG',
  'PAYMENT_DATA',
  'RATE_LIMITED',
  'AUTH_FORBIDDEN',
  'DATA_UNAVAILABLE',
  'NOT_FOUND',
  'NO_CAJA',
  'AMBIGUOUS_TARGET',
  'MODEL_UNAVAILABLE',
  'MODEL_TIMEOUT',
  // Write approval contract (Plan 29-03). Returned by the assistant_* RPCs; the client classifies by code.
  'TOO_MANY_ITEMS',
  'STALE_TARGET',
  'NOT_OWNER',
  'ALREADY_USED',
  'PROPOSAL_EXPIRED',
  'TERMINAL_MISMATCH',
  'PAYLOAD_MISMATCH',
  'ASSISTANT_LOCKED',
  'INVALID_APPROVAL',
  'APPROVAL_REQUIRED',
  'AMBIGUOUS_APPROVAL',
  'APPROVER_NOT_MANAGER',
  'STOCK_CHANGED',
  'EXECUTION_FAILED',
  // Plan 29-05: prices were sent but the server's verification (assistant_finish) did not come back.
  'RESULT_UNCONFIRMED',
]);
export type AssistantCode = z.infer<typeof AssistantCodeSchema>;

/** Typed refusal/failure the client classifies by code, never by message text. */
export type AssistantError = { code: AssistantCode };

const ProductLookupArgs = z.object({ query: z.string().trim().min(1).max(80) }).strict();
const StockLowArgs = z.object({ supplierQuery: z.string().trim().min(1).max(80).nullable() }).strict();
const ExpiryListArgs = z.object({ withinDays: z.number().int().min(0).max(60).nullable() }).strict();
/** Same reasons the server accepts (assistant_stage); stock_movements_reason_check allows all three. */
export const ADJUST_REASONS = ['waste', 'correction', 'manual_adjustment'] as const;
/** One item of a stock batch: the product is named, never identified, by the model; the gateway resolves it. */
const AdjustItem = z
  .object({
    query: z.string().trim().min(1).max(80),
    delta: z.number().int().min(-9999).max(9999).refine(n => n !== 0),
  })
  .strict();
export const MAX_BATCH_ITEMS = 25;
/** One price change: the product is named by the model, the price is whole cents (the server limit is 100000.00). */
const PriceItem = z
  .object({
    query: z.string().trim().min(1).max(80),
    priceCents: z.number().int().min(1).max(10_000_000),
  })
  .strict();
const ProductPriceArgs = z.object({ items: z.array(PriceItem).min(1).max(MAX_BATCH_ITEMS) }).strict();
const InventoryAdjustArgs = z
  .object({ reason: z.enum(ADJUST_REASONS), items: z.array(AdjustItem).min(1).max(MAX_BATCH_ITEMS) })
  .strict();

export const Proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('refuse'), reason: z.enum(['unsupported', 'unsafe', 'ambiguous']) }).strict(),
  z.object({ kind: z.literal('product.lookup'), args: ProductLookupArgs }).strict(),
  z.object({ kind: z.literal('expiry.list'), args: ExpiryListArgs }).strict(),
  z.object({ kind: z.literal('stock.low'), args: StockLowArgs }).strict(),
  z.object({ kind: z.literal('sales.summary'), args: z.object({}).strict() }).strict(),
  z.object({ kind: z.literal('inventory.adjust'), args: InventoryAdjustArgs }).strict(),
  z.object({ kind: z.literal('product.price'), args: ProductPriceArgs }).strict(),
]);
export type Proposal = z.infer<typeof Proposal>;
export type ProposalKind = Proposal['kind'];

/** Returns the proposal, or null for anything that is not exactly one valid, registered object. */
export function parseProposal(text: string): Proposal | null {
  try {
    const result = Proposal.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Grammar handed to llama.cpp; `$schema` is dropped, the test pins no $ref/format/pattern (research A6). */
export const proposalJsonSchema: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(Proposal) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
})();

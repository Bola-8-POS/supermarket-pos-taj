import { z } from 'zod';
import { OfflineSaleLastCodeSchema, OfflineSaleStatusSchema, UuidSchema } from './domain';
import { ProcessDirectSaleRequestSchema, ServerReceiptDataSchema } from './edge-function-contracts';

/**
 * What the provisional receipt prints for one sold line, captured when the
 * sale is rung so the receipt can be rebuilt from the record alone. Display
 * only: prices are server-validated and these names are not hashed.
 */
export const OfflineSaleLineSchema = z.object({
  productId: UuidSchema,
  name: z.string(),
  categoryName: z.string().nullable(),
  modifierNames: z.array(z.string()),
});

/**
 * One direct sale rung while the backend was unreachable (two-mode Plan 02b,
 * Ruling 8). `request` is the full body checkout would have sent, stored
 * verbatim; no event ever edits it. Lives apart from `domain.ts` because it
 * embeds the process-direct-sale request, and edge-function-contracts already
 * imports domain.ts (importing back would be a cycle).
 */
export const OfflineSaleSchema = z.object({
  /** Local provisional id; the provisional receipt number derives from it. */
  id: UuidSchema,
  request: ProcessDirectSaleRequestSchema,
  /** Display snapshot aligned by index with `request.items`; empty on a salvaged record. */
  lines: z.array(OfflineSaleLineSchema).default([]),
  /** ISO timestamp from the effective clock when the sale was rung. */
  soldAt: z.string().min(1),
  staffId: UuidSchema,
  staffName: z.string(),
  /** Provisional number, `P-` + first 6 chars of `id`. */
  receiptNumber: z.string().min(1),
  status: OfflineSaleStatusSchema,
  /** Counted failed attempts (unreachable outcomes do not count). */
  attempts: z.number().int().min(0),
  lastCode: OfflineSaleLastCodeSchema.optional(),
  lastMessage: z.string().optional(),
  /** SHA-256 hex over the canonical request + soldAt + receiptNumber. */
  integrity: z.string().min(1),
  /** ISO time before which a `queued` sale must not be replayed (backoff). */
  nextAttemptAt: z.string().optional(),
  /** Server tab id and receipt, set on `confirmed`. */
  tabId: UuidSchema.optional(),
  confirmedReceipt: ServerReceiptDataSchema.optional(),
  confirmedAt: z.string().optional(),
  /**
   * Set when storage pressure dropped `confirmedReceipt` and `lines` from a settled record (R72):
   * the server holds the sale, so it reprints from Payments. An explicit marker, never inferred
   * from a missing receipt. Terminal records only.
   */
  slimmed: z.boolean().optional(),
  /** `already_recorded`: the server holds this sale (a lost answer), so nothing was written off or re-rung. */
  resolution: z.enum(['rering', 'written_off', 'already_recorded']).optional(),
  resolvedBy: UuidSchema.optional(),
  resolvedAt: z.string().optional(),
  /** Tab of the re-rung sale (`rering`) or of the sale the server already holds (`already_recorded`). */
  linkedTabId: UuidSchema.optional(),
  /** What the customer paid above today's price on a re-ring. */
  customerOverpaid: z.number().nonnegative().optional(),
  /** How much less the server sale a write-off or review linked holds than the offline sale. */
  amountShort: z.number().nonnegative().optional(),
  /** The paid re-ring tab that also reached the server when the record was closed with the original. */
  duplicateReringTabId: UuidSchema.optional(),
  /**
   * Idempotency keys of every re-ring payment attempt, stored BEFORE the request leaves the till,
   * newest last and capped (D13). Lets the server pre-check find a re-rung twin after a restart.
   * Like `lines`, not hashed and never a reason to drop a record.
   */
  reRingAttemptKeys: z.array(z.string()).default([]),
  /**
   * A resolution call (write-off, re-ring) ended with no answer at all: the server may have committed it.
   * While set, Retry is refused (a write-off may already stand); any answer clears it. Not hashed.
   */
  resolutionOutcomeUnknown: z.boolean().default(false),
});
export type OfflineSale = z.infer<typeof OfflineSaleSchema>;

/**
 * Carried by the checkout cart while a manager re-sells an offline sale the server refused
 * (two-mode Plan 02b, Task 6b). Persisted with the cart so a restart keeps the link between the
 * new sale and the old record; the new sale's success closes the record as `rering`.
 */
export const ReRingMarkerSchema = z.object({
  /** The offline record being re-rung. */
  saleId: UuidSchema,
  approvedBy: UuidSchema,
  approvalId: z.string().min(1),
  /** What the customer paid: the record's provisional total. */
  paidTotal: z.number().nonnegative(),
});
export type ReRingMarker = z.infer<typeof ReRingMarkerSchema>;

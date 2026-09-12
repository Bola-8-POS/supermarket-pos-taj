/**
 * EDGE FUNCTION CONTRACTS
 *
 * Defines request and response schemas for every Supabase Edge Function.
 * These schemas are validated with Zod on BOTH the client (before sending)
 * and server (after receiving).
 */

import { z } from 'zod';
import type { AnthropicMessage } from './agent/anthropic-types';
import {
  MoneySchema,
  UuidSchema,
  TimestampSchema,
  PaymentMethodSchema,
  DiscountScopeSchema,
  DiscountTypeSchema,
  PinSchema,
  UserRoleSchema,
  LocaleSchema,
} from './domain';
import { logger } from './logger';
import { ok, err, inventoryNegativeError, type Result } from './result';
import { supabase, getCachedAccessToken } from './supabase';
import type { AppError } from './supabase-contracts';

// ============================================================================
// SHARED SCHEMAS
// ============================================================================

/**
 * One tender leg of a sale-level receipt (Phase 2 gap closure, CHK-04 /
 * CR-03). A single-tender sale has exactly one entry; a split sale has one
 * entry per payment leg — the basket/items above are never duplicated per
 * leg, only the tender breakdown repeats.
 */
export const ReceiptTenderSchema = z.object({
  method: PaymentMethodSchema,
  amount: MoneySchema,
  tenderedAmount: MoneySchema.nullable().optional(),
  changeAmount: MoneySchema.nullable().optional(),
  /** Terminal / BBVA receipt reference — never log raw value */
  terminalReference: z.string().max(64).nullable().optional(),
});

export type ReceiptTender = z.infer<typeof ReceiptTenderSchema>;

/**
 * Receipt data returned after successful payment processing.
 */
export const ReceiptDataSchema = z.object({
  receiptNumber: z.string(),
  tabId: UuidSchema,
  customerName: z.string(),
  cashierName: z.string(),
  storeName: z.string(),
  barAddress: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().int().positive(),
      unitPrice: MoneySchema,
      lineTotal: MoneySchema,
      categoryId: UuidSchema.nullable().optional(),
      categoryName: z.string().nullable().optional(),
      modifierNames: z.array(z.string()).optional(),
      weightGrams: z.number().int().positive().max(50000).nullable().optional(),
      promotionId: UuidSchema.nullable().optional(),
      discountRate: z.number().nonnegative().nullable().optional(),
      discountAmount: MoneySchema.nullable().optional(),
    })
  ),
  subtotal: MoneySchema,
  total: MoneySchema,
  /** Phase 24 (TAX-05): decomposed tax line — optional so pre-migration/other-flow receipts without it still parse. */
  taxAmount: MoneySchema.optional(),
  taxRatePercent: z.number().optional(),
  taxInclusive: z.boolean().optional(),
  paymentMethod: PaymentMethodSchema,
  processedAt: TimestampSchema,
  squareReceiptUrl: z.string().nullable(),
  tenderedAmount: MoneySchema.nullable().optional(),
  changeAmount: MoneySchema.nullable().optional(),
  /** Terminal / BBVA receipt reference — never log raw value */
  terminalReference: z.string().max(64).nullable().optional(),
  discountAmount: MoneySchema.nullable().optional(),
  discountScope: DiscountScopeSchema.nullable().optional(),
  discountType: DiscountTypeSchema.nullable().optional(),
  discountValue: z.number().nonnegative().nullable().optional(),
  /**
   * Every tender leg of the sale (Phase 2 gap closure, CHK-04). Present on
   * direct-sale receipts; omitted by the untouched generic per-leg
   * process-split-payment receipts (D-09), which callers should keep
   * reading via the top-level paymentMethod/tenderedAmount/changeAmount
   * fields instead.
   */
  tenders: z.array(ReceiptTenderSchema).optional(),
});

export type ReceiptData = z.infer<typeof ReceiptDataSchema>;

// ============================================================================
// PROCESS PAYMENT
// ============================================================================

/**
 * Request schema for process-payment edge function.
 */
export const ProcessPaymentRequestSchema = z
  .object({
    tabId: UuidSchema,
    amount: MoneySchema,
    method: PaymentMethodSchema.exclude(['bank_transfer']),
    idempotencyKey: z.string().min(1).max(255),
    tenderedAmount: MoneySchema.nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
    discountScope: DiscountScopeSchema.optional(),
    discountType: DiscountTypeSchema.optional(),
    discountValue: z.number().nonnegative().optional(),
    discountAmount: MoneySchema.optional(),
    /** Phase 27 Plan 09 (G-27-13): live manager-PIN authorization path for `process_payment_atomic`'s DISCOUNT_REQUIRES_MANAGER guard — required (server-side, not by this schema) whenever a discount field is present. `undefined` here must reach the RPC as `false`, never `null`: a NULL boolean satisfies neither `IF p_manager_override THEN` nor `IF NOT p_manager_override THEN` in PL/pgSQL, silently skipping the guard. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08/09 (G-27-13): the entered PIN of the staff who authorized managerOverride — the RPC re-derives the authorizing identity from this PIN independently, never from the caller's own staff id. */
    managerPin: z.string().optional(),
    /** Phase 15 gap-closure (D-02): cached tab.version for optimistic-concurrency guard. */
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.method === 'cash' && data.tenderedAmount == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'tenderedAmount is required for cash',
        path: ['tenderedAmount'],
      });
    }
    if (data.method !== 'cash' && data.tenderedAmount != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'tenderedAmount is only valid for cash',
        path: ['tenderedAmount'],
      });
    }
  });

export type ProcessPaymentRequest = z.infer<typeof ProcessPaymentRequestSchema>;

const ProcessPaymentErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** Successful payload after {@link callProcessPayment} unwraps the edge envelope. */
export const ProcessPaymentSuccessSchema = z.object({
  paymentId: UuidSchema,
  receiptData: ReceiptDataSchema,
  idempotent: z.boolean().optional(),
});

export type ProcessPaymentSuccess = z.infer<typeof ProcessPaymentSuccessSchema>;

export const ProcessPaymentEnvelopeSchema = z.object({
  success: z.boolean(),
  paymentId: UuidSchema.optional(),
  receiptData: ReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});

function mapProcessPaymentEdgeError(code: string | undefined, message: string): AppError {
  if (code === 'DIRECT_SALE_FAILED' && message.startsWith('INVENTORY_NEGATIVE:')) {
    return inventoryNegativeError(message.slice('INVENTORY_NEGATIVE:'.length).trim());
  }
  switch (code) {
    case 'POOL_SESSION_ACTIVE':
      return { code: 'SESSION_STILL_RUNNING', message };
    case 'TAB_NOT_OPEN':
    case 'TAB_NOT_FOUND':
      return { code: 'TAB_ALREADY_CLOSED', message };
    case 'AMOUNT_MISMATCH':
    case 'TENDERED_REQUIRED':
    case 'INSUFFICIENT_TENDER':
    case 'TENDERED_NOT_ALLOWED':
    case 'RAPPI_ORDER_MISMATCH':
    case 'INVALID_METHOD':
    case 'VALIDATION_ERROR':
    case 'IDEMPOTENCY_MISMATCH':
      return { code: 'VALIDATION_ERROR', message };
    case 'FORBIDDEN':
      return { code: 'AUTH_FORBIDDEN', message };
    case 'CAJA_CLOSED':
      return { code: 'CAJA_CLOSED', message };
    case 'SHIFT_NOT_OPEN':
      return { code: 'AUTH_FORBIDDEN', message };
    case 'UNAUTHORIZED':
      return { code: 'AUTH_REQUIRED', message };
    // Phase 27 (PROMO-05/07): process_direct_sale_atomic's manager-override codes.
    case 'BELOW_COST_REQUIRES_OVERRIDE':
      return { code: 'BELOW_COST_REQUIRES_OVERRIDE', message };
    case 'DISCOUNT_REQUIRES_MANAGER':
      return { code: 'DISCOUNT_REQUIRES_MANAGER', message };
    case 'INVALID_DISCOUNT_SCOPE':
      return { code: 'VALIDATION_ERROR', message };
    default:
      return { code: 'SUPABASE_ERROR', message, details: code ?? '' };
  }
}

/**
 * Calls the process-payment edge function.
 *
 * @returns Unwrapped success payload or structured {@link AppError}.
 */
export async function callProcessPayment(
  request: ProcessPaymentRequest
): Promise<Result<ProcessPaymentSuccess, AppError>> {
  try {
    const validatedRequest = ProcessPaymentRequestSchema.parse(request);

    // supabase.functions getter creates a new FunctionsClient with static anon-key headers on
    // every access — the user JWT is never injected. Use fetch() directly with the cached token.
    // getCachedAccessToken() is populated by onAuthStateChange (set at signIn, cleared at signOut)
    // and is reliable in all environments including Playwright where getSession() can return null.
    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/process-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(validatedRequest),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      // Edge function envelope: { success: false, error: { code, message } }
      const edgeErr =
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error: { code?: unknown; message?: unknown } }).error
          : null;
      const edgeCode = typeof edgeErr?.code === 'string' ? edgeErr.code : undefined;
      const edgeMsg =
        typeof edgeErr?.message === 'string'
          ? edgeErr.message
          : `Payment service error (${String(response.status)})`;
      return err(mapProcessPaymentEdgeError(edgeCode, edgeMsg));
    }

    const envelope = ProcessPaymentEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from payment service',
        details: envelope.error.message,
      });
    }

    const body = envelope.data;
    if (!body.success || body.paymentId == null || body.receiptData == null) {
      const e = body.error;
      return err(
        mapProcessPaymentEdgeError(e?.code, e?.message ?? 'Payment could not be completed.')
      );
    }

    const success = ProcessPaymentSuccessSchema.safeParse({
      paymentId: body.paymentId,
      receiptData: body.receiptData,
      idempotent: body.idempotent,
    });
    if (!success.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid receipt payload',
        details: success.error.message,
      });
    }

    return ok(success.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// CREATE STAFF (Phase 08, SALE-02)
// ============================================================================

export const CreateStaffRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  pin: PinSchema,
  role: UserRoleSchema,
  locale: LocaleSchema.optional(),
});

export type CreateStaffRequest = z.infer<typeof CreateStaffRequestSchema>;

export const CreateStaffSuccessSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  role: UserRoleSchema,
});

export type CreateStaffSuccess = z.infer<typeof CreateStaffSuccessSchema>;

/** create-staff/index.ts's flat error envelope: `{ error: string }` (not process-payment's `{error:{code,message}}`). */
function mapCreateStaffEdgeError(status: number, message: string): AppError {
  if (status === 401) return { code: 'AUTH_REQUIRED', message };
  if (status === 403) return { code: 'AUTH_FORBIDDEN', message };
  return { code: 'SUPABASE_ERROR', message };
}

/**
 * Calls the create-staff edge function.
 *
 * @returns Unwrapped success payload or structured {@link AppError}.
 */
export async function callCreateStaff(
  request: CreateStaffRequest
): Promise<Result<CreateStaffSuccess, AppError>> {
  try {
    const validatedRequest = CreateStaffRequestSchema.parse(request);

    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/create-staff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(validatedRequest),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const edgeMessage =
        data !== null &&
        typeof data === 'object' &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : `Could not create staff account (${String(response.status)})`;
      return err(mapCreateStaffEdgeError(response.status, edgeMessage));
    }

    const success = CreateStaffSuccessSchema.safeParse(data);
    if (!success.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from staff service',
        details: success.error.message,
      });
    }

    return ok(success.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// ADMIN RESET PIN (Phase 22, PINRST-01..08)
// ============================================================================

export const AdminResetPinRequestSchema = z.object({
  targetStaffId: UuidSchema,
  newPin: PinSchema,
});

export type AdminResetPinRequest = z.infer<typeof AdminResetPinRequestSchema>;

export const AdminResetPinSuccessSchema = z.object({
  id: UuidSchema,
  name: z.string(),
});

export type AdminResetPinSuccess = z.infer<typeof AdminResetPinSuccessSchema>;

/**
 * admin-reset-pin/index.ts's flat error envelope: `{ error: string }` (same
 * shape as create-staff, not process-payment's nested `{error:{code,message}}`).
 * Exported (unlike mapCreateStaffEdgeError) so it's directly unit-testable —
 * the PARTIAL_FAILURE branch (Pitfall 1's dual-write divergence) is the one
 * genuinely new risk this phase introduces and needs its own coverage.
 */
export function mapAdminResetPinEdgeError(status: number, message: string): AppError {
  if (message.startsWith('PARTIAL_FAILURE')) return { code: 'PIN_RESET_PARTIAL_FAILURE', message };
  if (status === 401) return { code: 'AUTH_REQUIRED', message };
  if (status === 403) return { code: 'AUTH_FORBIDDEN', message };
  if (status === 404) return { code: 'NOT_FOUND', message };
  return { code: 'SUPABASE_ERROR', message };
}

/**
 * Calls the admin-reset-pin edge function.
 *
 * @returns Unwrapped success payload or structured {@link AppError}.
 */
export async function callAdminResetPin(
  request: AdminResetPinRequest
): Promise<Result<AdminResetPinSuccess, AppError>> {
  try {
    const validatedRequest = AdminResetPinRequestSchema.parse(request);

    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/admin-reset-pin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(validatedRequest),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const edgeMessage =
        data !== null &&
        typeof data === 'object' &&
        'error' in data &&
        typeof data.error === 'string'
          ? data.error
          : `Could not reset PIN (${String(response.status)})`;
      return err(mapAdminResetPinEdgeError(response.status, edgeMessage));
    }

    const success = AdminResetPinSuccessSchema.safeParse(data);
    if (!success.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from staff service',
        details: success.error.message,
      });
    }

    return ok(success.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// AGENT PROXY (Phase 06, SEC-01)
// ============================================================================

/**
 * Mirrors agent-proxy/index.ts's Deno BodySchema field-for-field. Forwarded
 * opaquely to Anthropic — do not deeply validate message/tool internals or
 * the model string (D-01's thin-proxy framing).
 */
export const AgentProxyRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  system: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()),
});

export type AgentProxyRequest = z.infer<typeof AgentProxyRequestSchema>;

/** agent-proxy's own failure-envelope shape — never used on the success path. */
export const AgentProxyErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
});

/**
 * LOOSE validator — only pins down what callers (brain.ts/vision.ts) actually
 * read (`content[].type`, `stop_reason`), passing everything else (id, role,
 * usage, etc.) through unmodified via `.loose()`. Do NOT deep-validate
 * every possible content-block shape — that would risk rejecting valid
 * Anthropic responses.
 */
export const AnthropicMessageResponseSchema = z
  .object({
    content: z.array(z.object({ type: z.string() }).loose()),
    stop_reason: z.string().nullable(),
  })
  .loose();

/**
 * Calls the agent-proxy edge function — a thin Bearer-authenticated pass-through
 * to the Anthropic Messages API. Every Anthropic request from brain.ts/vision.ts
 * flows through this function; the client never holds an Anthropic API key.
 *
 * @returns Unwrapped Anthropic {@link AnthropicMessage} or structured {@link AppError}.
 */
export async function callAgentProxy(
  request: AgentProxyRequest
): Promise<Result<AnthropicMessage, AppError>> {
  try {
    const validatedRequest = AgentProxyRequestSchema.parse(request);

    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/agent-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(validatedRequest),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const errBody = AgentProxyErrorBodySchema.safeParse(
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error: unknown }).error
          : null
      );
      const message = errBody.success
        ? errBody.data.message
        : `Agent service error (${String(response.status)})`;
      // Every agent-proxy failure code maps to AGENT_ERROR — this proxy has
      // no other domain-specific codes to distinguish.
      return err({ code: 'AGENT_ERROR', message });
    }

    const parsed = AnthropicMessageResponseSchema.safeParse(data);
    if (!parsed.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from agent-proxy',
        details: parsed.error.message,
      });
    }

    // AnthropicMessageResponseSchema is a deliberately loose passthrough validator
    // (only content[].type / stop_reason are pinned down) — the full AnthropicMessage
    // shape (id, type, role, etc.) is trusted to come through from Anthropic's API.
    return ok(parsed.data as unknown as AnthropicMessage);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// PROCESS DIRECT SALE
// ============================================================================

export const DirectSaleItemSchema = z.object({
  productId: UuidSchema,
  quantity: z.number().int().positive().max(99),
  unitPrice: MoneySchema,
  modifierIds: z.array(UuidSchema).default([]),
  modifierPriceDelta: MoneySchema.default(0),
  weightGrams: z.number().int().positive().max(50000).optional(),
  notes: z.string().max(200).nullable().optional(),
});

export const ProcessDirectSaleRequestSchema = z
  .object({
    items: z.array(DirectSaleItemSchema).min(1),
    shiftId: UuidSchema,
    cajaSessionId: UuidSchema,
    idempotencyKey: z.string().min(1).max(255),
    method: PaymentMethodSchema.optional(),
    amount: MoneySchema.optional(),
    tenderedAmount: MoneySchema.nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
    legs: z
      .array(
        z.object({
          method: PaymentMethodSchema.exclude(['bank_transfer']),
          amount: MoneySchema,
          tenderedAmount: MoneySchema.nullable().optional(),
          referenceNumber: z.string().max(64).nullable().optional(),
        })
      )
      .min(1)
      .max(4)
      .optional(),
    expectedTotal: MoneySchema.optional(),
    discountScope: DiscountScopeSchema.optional(),
    discountType: DiscountTypeSchema.optional(),
    discountValue: z.number().nonnegative().optional(),
    discountAmount: MoneySchema.optional(),
    customerName: z.string().min(1).max(100).optional(),
    customerPhone: z.string().min(1).max(30).optional(),
    /** Phase 27 (PROMO-05/07): manager-PIN authorization for the ad-hoc discount and/or the below-cost floor-guard override. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08 (G-27-13): the entered PIN of the staff who authorized managerOverride — forwarded to process_direct_sale_atomic for independent server-side re-verification. */
    managerPin: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.method == null) === (data.legs == null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide exactly one payment method or split legs',
        path: ['method'],
      });
    }
    if (data.method === 'cash' && data.tenderedAmount == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'tenderedAmount is required for cash',
        path: ['tenderedAmount'],
      });
    }
    if (data.method === 'bank_transfer' && !data.customerPhone?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'customerPhone is required for bank_transfer',
        path: ['customerPhone'],
      });
    }
  });

export type ProcessDirectSaleRequest = z.infer<typeof ProcessDirectSaleRequestSchema>;

export const ProcessDirectSaleSuccessSchema = z.object({
  tabId: UuidSchema,
  paymentId: UuidSchema.optional(),
  paymentGroupId: UuidSchema.optional(),
  paymentIds: z.array(UuidSchema).optional(),
  /**
   * One sale-level receipt for both direct and split-tender direct sales
   * (Phase 2 gap closure, CHK-04 / CR-03) — the basket is composed once and
   * every payment leg appears in `receiptData.tenders`, replacing the old
   * per-leg `receipts` array that repeated the whole basket for each leg.
   */
  receiptData: ReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
});

export type ProcessDirectSaleSuccess = z.infer<typeof ProcessDirectSaleSuccessSchema>;

const ProcessDirectSaleEnvelopeSchema = z.object({
  success: z.boolean(),
  tabId: UuidSchema.optional(),
  paymentId: UuidSchema.optional(),
  paymentGroupId: UuidSchema.optional(),
  paymentIds: z.array(UuidSchema).optional(),
  receiptData: ReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});

export async function callProcessDirectSale(
  request: ProcessDirectSaleRequest
): Promise<Result<ProcessDirectSaleSuccess, AppError>> {
  try {
    const validatedRequest = ProcessDirectSaleRequestSchema.parse(request);
    const accessToken = getCachedAccessToken();
    if (!accessToken) return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });

    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-direct-sale`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(validatedRequest),
      }
    );
    const data: unknown = await response.json().catch(() => null);
    const envelope = ProcessDirectSaleEnvelopeSchema.safeParse(data);
    if (!response.ok || !envelope.success || !envelope.data.success) {
      const edge = envelope.success ? envelope.data.error : undefined;
      logger.error(
        'process_direct_sale.failed',
        {
          httpStatus: response.status,
          envelopeParsed: envelope.success,
          edgeErrorCode: edge?.code ?? null,
        },
        envelope.success ? undefined : envelope.error
      );
      return err(
        mapProcessPaymentEdgeError(edge?.code, edge?.message ?? 'Payment could not be completed.')
      );
    }
    const result = ProcessDirectSaleSuccessSchema.safeParse(envelope.data);
    if (!result.success) {
      logger.error(
        'process_direct_sale.invalid_response',
        { httpStatus: response.status },
        result.error
      );
    }
    return result.success
      ? ok(result.data)
      : err({
          code: 'VALIDATION_ERROR',
          message: 'Invalid receipt payload',
          details: result.error.message,
        });
  } catch (error) {
    logger.error('process_direct_sale.exception', {}, error);
    return err({
      code: error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// RECEIVE SHIPMENT
// ============================================================================
export const ShipmentLineItemSchema = z.object({
  productId: UuidSchema,
  quantity: z.number().int().positive().max(9999),
  costPrice: MoneySchema,
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export const ReceiveShipmentRequestSchema = z.object({
  supplierId: UuidSchema,
  items: z.array(ShipmentLineItemSchema).min(1).max(50),
  poId: UuidSchema.nullable().optional(),
});
export const ReceiveShipmentSuccessSchema = z.object({ shipmentId: UuidSchema });
export type ReceiveShipmentRequest = z.infer<typeof ReceiveShipmentRequestSchema>;
export type ReceiveShipmentSuccess = z.infer<typeof ReceiveShipmentSuccessSchema>;
const ReceiveShipmentEnvelopeSchema = z.object({
  success: z.boolean(),
  shipmentId: UuidSchema.optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});
export async function callReceiveShipment(
  request: ReceiveShipmentRequest
): Promise<Result<ReceiveShipmentSuccess, AppError>> {
  try {
    const body = ReceiveShipmentRequestSchema.parse(request);
    const accessToken = getCachedAccessToken();
    if (!accessToken) return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receive-shipment`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      }
    );
    const envelope = ReceiveShipmentEnvelopeSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!response.ok || !envelope.success || !envelope.data.success) {
      const edge = envelope.success ? envelope.data.error : undefined;
      return err(
        mapProcessPaymentEdgeError(edge?.code, edge?.message ?? 'Shipment could not be received.')
      );
    }
    const result = ReceiveShipmentSuccessSchema.safeParse(envelope.data);
    return result.success
      ? ok(result.data)
      : err({ code: 'VALIDATION_ERROR', message: 'Invalid shipment payload' });
  } catch (error) {
    return err({
      code: error instanceof z.ZodError ? 'VALIDATION_ERROR' : 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// PROCESS SPLIT PAYMENT
// ============================================================================

/**
 * Request schema for one leg (row) of a split-payment submission.
 * Defined locally (not reusing SplitPaymentLegSchema from domain.ts) —
 * contracts own their wire shape, mirroring ProcessPaymentRequestSchema.
 */
export const SplitPaymentLegRequestSchema = z
  .object({
    method: PaymentMethodSchema.exclude(['bank_transfer']),
    amount: MoneySchema,
    tenderedAmount: MoneySchema.nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.method === 'cash' && data.tenderedAmount == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'tenderedAmount is required for cash',
        path: ['tenderedAmount'],
      });
    }
    if (data.method !== 'cash' && data.tenderedAmount != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'tenderedAmount is only valid for cash',
        path: ['tenderedAmount'],
      });
    }
  });

/**
 * Request schema for process-split-payment edge function.
 * Max 4 legs enforces D-02. Top-level superRefine is a client-side
 * defense-in-depth check (D-05) — the RPC re-validates authoritatively.
 */
export const ProcessSplitPaymentRequestSchema = z
  .object({
    tabId: UuidSchema,
    legs: z.array(SplitPaymentLegRequestSchema).min(1).max(4),
    expectedTotal: MoneySchema,
    idempotencyKey: z.string().min(1).max(255),
    discountScope: DiscountScopeSchema.optional(),
    discountType: DiscountTypeSchema.optional(),
    discountValue: z.number().nonnegative().optional(),
    discountAmount: MoneySchema.optional(),
    /** Phase 27 Plan 09 (G-27-13): live manager-PIN authorization path for `process_split_payment_atomic`'s DISCOUNT_REQUIRES_MANAGER guard — required (server-side, not by this schema) whenever a discount field is present. `undefined` here must reach the RPC as `false`, never `null`: a NULL boolean satisfies neither `IF p_manager_override THEN` nor `IF NOT p_manager_override THEN` in PL/pgSQL, silently skipping the guard. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08/09 (G-27-13): the entered PIN of the staff who authorized managerOverride — the RPC re-derives the authorizing identity from this PIN independently, never from the caller's own staff id. */
    managerPin: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const legsTotal = data.legs.reduce((sum, leg) => sum + leg.amount, 0);
    if (Math.abs(legsTotal - data.expectedTotal) > 0.01) {
      ctx.addIssue({
        code: 'custom',
        message: 'Sum of leg amounts must equal expectedTotal',
        path: ['legs'],
      });
    }
  });

export type ProcessSplitPaymentRequest = z.infer<typeof ProcessSplitPaymentRequestSchema>;

/** Successful payload after {@link callProcessSplitPayment} unwraps the edge envelope. */
export const ProcessSplitPaymentSuccessSchema = z.object({
  paymentGroupId: UuidSchema,
  paymentIds: z.array(UuidSchema).min(1).max(4),
  receipts: z.array(ReceiptDataSchema).min(1).max(4),
  idempotent: z.boolean().optional(),
});

export type ProcessSplitPaymentSuccess = z.infer<typeof ProcessSplitPaymentSuccessSchema>;

export const ProcessSplitPaymentEnvelopeSchema = z.object({
  success: z.boolean(),
  paymentGroupId: UuidSchema.optional(),
  paymentIds: z.array(UuidSchema).optional(),
  receipts: z.array(ReceiptDataSchema).optional(),
  idempotent: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

function mapProcessSplitPaymentEdgeError(code: string | undefined, message: string): AppError {
  switch (code) {
    case 'POOL_SESSION_ACTIVE':
      return { code: 'SESSION_STILL_RUNNING', message };
    case 'TAB_NOT_OPEN':
    case 'TAB_NOT_FOUND':
      return { code: 'TAB_ALREADY_CLOSED', message };
    case 'AMOUNT_MISMATCH':
    case 'TENDERED_REQUIRED':
    case 'INSUFFICIENT_TENDER':
    case 'TENDERED_NOT_ALLOWED':
    case 'RAPPI_ORDER_MISMATCH':
    case 'INVALID_METHOD':
    case 'VALIDATION_ERROR':
    case 'IDEMPOTENCY_MISMATCH':
    case 'SPLIT_TOTAL_MISMATCH':
    case 'TOO_MANY_LEGS':
    case 'EMPTY_LEG':
      return { code: 'VALIDATION_ERROR', message };
    case 'FORBIDDEN':
      return { code: 'AUTH_FORBIDDEN', message };
    case 'UNAUTHORIZED':
      return { code: 'AUTH_REQUIRED', message };
    default:
      return { code: 'SUPABASE_ERROR', message, details: code ?? '' };
  }
}

/**
 * Calls the process-split-payment edge function.
 *
 * @returns Unwrapped success payload or structured {@link AppError}.
 */
export async function callProcessSplitPayment(
  request: ProcessSplitPaymentRequest
): Promise<Result<ProcessSplitPaymentSuccess, AppError>> {
  try {
    const validatedRequest = ProcessSplitPaymentRequestSchema.parse(request);

    // supabase.functions getter creates a new FunctionsClient with static anon-key headers on
    // every access — the user JWT is never injected. Use fetch() directly with the cached token.
    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    const response = await fetch(`${supabaseUrl}/functions/v1/process-split-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify(validatedRequest),
    });

    const data: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      // Edge function envelope: { success: false, error: { code, message } }
      const edgeErr =
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error: { code?: unknown; message?: unknown } }).error
          : null;
      const edgeCode = typeof edgeErr?.code === 'string' ? edgeErr.code : undefined;
      const edgeMsg =
        typeof edgeErr?.message === 'string'
          ? edgeErr.message
          : `Payment service error (${String(response.status)})`;
      return err(mapProcessSplitPaymentEdgeError(edgeCode, edgeMsg));
    }

    const envelope = ProcessSplitPaymentEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from payment service',
        details: envelope.error.message,
      });
    }

    const body = envelope.data;
    if (!body.success || body.paymentGroupId == null) {
      const e = body.error;
      return err(
        mapProcessSplitPaymentEdgeError(e?.code, e?.message ?? 'Payment could not be completed.')
      );
    }

    const success = ProcessSplitPaymentSuccessSchema.safeParse({
      paymentGroupId: body.paymentGroupId,
      paymentIds: body.paymentIds,
      receipts: body.receipts,
      idempotent: body.idempotent,
    });
    if (!success.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid receipt payload',
        details: success.error.message,
      });
    }

    return ok(success.data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// SEND RECEIPT EMAIL
// ============================================================================

export const SendReceiptEmailRequestSchema = z.object({
  email: z.string().trim().pipe(z.email('Enter a valid email address')),
  receiptPlainText: z.string().min(1).max(50_000),
  pdfBase64: z.string().max(2_000_000).optional(),
});

export type SendReceiptEmailRequest = z.infer<typeof SendReceiptEmailRequestSchema>;

const SendReceiptEmailErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const SendReceiptEmailEnvelopeSchema = z.object({
  success: z.boolean(),
  error: SendReceiptEmailErrorBodySchema.optional(),
});

/**
 * Calls the send-receipt-email edge function (Resend).
 */
export async function callSendReceiptEmail(
  request: SendReceiptEmailRequest
): Promise<Result<void, AppError>> {
  try {
    const validatedRequest = SendReceiptEmailRequestSchema.parse(request);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('send-receipt-email', {
      body: validatedRequest,
    });

    if (error) {
      const msg =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message: unknown }).message === 'string'
          ? (error as { message: string }).message
          : 'Could not send receipt email';
      return err({
        code: 'SUPABASE_ERROR',
        message: msg,
        details: JSON.stringify(error),
      });
    }

    const envelope = SendReceiptEmailEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from email service',
        details: envelope.error.message,
      });
    }

    const body = envelope.data;
    if (!body.success) {
      const e = body.error;
      return err({
        code: 'SUPABASE_ERROR',
        message: e?.message ?? 'Failed to send receipt email',
        ...(e?.code != null && e.code.length > 0 ? { details: e.code } : {}),
      });
    }

    return ok(undefined);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.message,
      });
    }

    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

function getInvokeErrorMessage(error: unknown, fallback: string): string {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : fallback;
}

// ============================================================================
// SETTINGS: BACKUP + RESTORE
// ============================================================================

export const CreateSettingsBackupRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
});

export type CreateSettingsBackupRequest = z.infer<typeof CreateSettingsBackupRequestSchema>;

export const CreateSettingsBackupResponseSchema = z.object({
  ok: z.boolean(),
  backupId: UuidSchema.optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export async function callCreateSettingsBackup(
  request: CreateSettingsBackupRequest
): Promise<Result<{ backupId: string }, AppError>> {
  try {
    const validated = CreateSettingsBackupRequestSchema.parse(request);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('settings-backup', {
      body: validated,
    });

    if (error) {
      return err({
        code: 'SUPABASE_ERROR',
        message: getInvokeErrorMessage(error, 'Could not create backup'),
      });
    }

    const envelope = CreateSettingsBackupResponseSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected backup response',
        details: envelope.error.message,
      });
    }
    if (!envelope.data.ok || !envelope.data.backupId) {
      return err({
        code: 'SUPABASE_ERROR',
        message: envelope.data.error?.message ?? 'Backup failed',
      });
    }
    return ok({ backupId: envelope.data.backupId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid backup request',
        details: error.message,
      });
    }
    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

export const RestoreSettingsBackupRequestSchema = z.object({
  backupId: UuidSchema,
});

export type RestoreSettingsBackupRequest = z.infer<typeof RestoreSettingsBackupRequestSchema>;

export const RestoreSettingsBackupResponseSchema = z.object({
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export async function callRestoreSettingsBackup(
  request: RestoreSettingsBackupRequest
): Promise<Result<void, AppError>> {
  try {
    const validated = RestoreSettingsBackupRequestSchema.parse(request);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('settings-restore', {
      body: validated,
    });

    if (error) {
      return err({
        code: 'SUPABASE_ERROR',
        message: getInvokeErrorMessage(error, 'Could not restore backup'),
      });
    }

    const envelope = RestoreSettingsBackupResponseSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected restore response',
        details: envelope.error.message,
      });
    }
    if (!envelope.data.ok) {
      return err({
        code: 'SUPABASE_ERROR',
        message: envelope.data.error?.message ?? 'Restore failed',
      });
    }
    return ok(undefined);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid restore request',
        details: error.message,
      });
    }
    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// SETTINGS: EMAIL STATUS + TEST
// ============================================================================

export const SettingsEmailStatusResponseSchema = z.object({
  ok: z.boolean(),
  resendConfigured: z.boolean().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export async function callSettingsEmailStatus(): Promise<
  Result<{ resendConfigured: boolean }, AppError>
> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('settings-email-status', {
      body: {},
    });
    if (error) {
      return err({
        code: 'SUPABASE_ERROR',
        message: getInvokeErrorMessage(error, 'Could not check email status'),
      });
    }
    const envelope = SettingsEmailStatusResponseSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from email status function',
        details: envelope.error.message,
      });
    }
    if (!envelope.data.ok || envelope.data.resendConfigured == null) {
      return err({
        code: 'SUPABASE_ERROR',
        message: envelope.data.error?.message ?? 'Could not check email status',
      });
    }
    return ok({ resendConfigured: envelope.data.resendConfigured });
  } catch (error) {
    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

export const SettingsTestEmailRequestSchema = z.object({
  email: z.string().trim().pipe(z.email('Enter a valid email address')),
});

export type SettingsTestEmailRequest = z.infer<typeof SettingsTestEmailRequestSchema>;

export const SettingsTestEmailResponseSchema = z.object({
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export async function callSendSettingsTestEmail(
  request: SettingsTestEmailRequest
): Promise<Result<void, AppError>> {
  try {
    const validated = SettingsTestEmailRequestSchema.parse(request);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('settings-test-email', {
      body: validated,
    });

    if (error) {
      return err({
        code: 'SUPABASE_ERROR',
        message: getInvokeErrorMessage(error, 'Could not send test email'),
      });
    }

    const envelope = SettingsTestEmailResponseSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected test email response',
        details: envelope.error.message,
      });
    }
    if (!envelope.data.ok) {
      return err({
        code: 'SUPABASE_ERROR',
        message: envelope.data.error?.message ?? 'Could not send test email',
      });
    }
    return ok(undefined);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Invalid test email request',
        details: error.message,
      });
    }
    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// GET SERVER TIME
// ============================================================================

/**
 * Response schema for get-server-time edge function.
 */
export const GetServerTimeResponseSchema = z.object({
  serverTime: z.string(),
});

export type GetServerTimeResponse = z.infer<typeof GetServerTimeResponseSchema>;

/**
 * Calls the get-server-time edge function.
 *
 * @returns Result with server ISO 8601 timestamp or error.
 */
export async function callGetServerTime(): Promise<Result<GetServerTimeResponse, AppError>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('get-server-time', {
      body: {},
    });

    if (error) {
      return err({
        code: 'SUPABASE_ERROR',
        message: getInvokeErrorMessage(error, 'Could not fetch server time'),
      });
    }

    const envelope = GetServerTimeResponseSchema.safeParse(data);
    if (!envelope.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from get-server-time function',
        details: envelope.error.message,
      });
    }

    return ok(envelope.data);
  } catch (error) {
    return err({
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
}

// ============================================================================
// EDGE FUNCTION REGISTRY
// ============================================================================

/**
 * Registry of all edge functions with their schemas.
 * Useful for documentation and validation.
 */
export const EDGE_FUNCTIONS = {
  'process-payment': {
    requestSchema: ProcessPaymentRequestSchema,
    responseSchema: ProcessPaymentEnvelopeSchema,
    caller: callProcessPayment,
  },
  'process-split-payment': {
    requestSchema: ProcessSplitPaymentRequestSchema,
    responseSchema: ProcessSplitPaymentEnvelopeSchema,
    caller: callProcessSplitPayment,
  },
  'send-receipt-email': {
    requestSchema: SendReceiptEmailRequestSchema,
    responseSchema: SendReceiptEmailEnvelopeSchema,
    caller: callSendReceiptEmail,
  },
  'settings-backup': {
    requestSchema: CreateSettingsBackupRequestSchema,
    responseSchema: CreateSettingsBackupResponseSchema,
    caller: callCreateSettingsBackup,
  },
  'settings-restore': {
    requestSchema: RestoreSettingsBackupRequestSchema,
    responseSchema: RestoreSettingsBackupResponseSchema,
    caller: callRestoreSettingsBackup,
  },
  'settings-email-status': {
    requestSchema: z.object({}),
    responseSchema: SettingsEmailStatusResponseSchema,
    caller: callSettingsEmailStatus,
  },
  'settings-test-email': {
    requestSchema: SettingsTestEmailRequestSchema,
    responseSchema: SettingsTestEmailResponseSchema,
    caller: callSendSettingsTestEmail,
  },
  'get-server-time': {
    requestSchema: z.object({}),
    responseSchema: GetServerTimeResponseSchema,
    caller: callGetServerTime,
  },
  'agent-proxy': {
    requestSchema: AgentProxyRequestSchema,
    responseSchema: AnthropicMessageResponseSchema,
    caller: callAgentProxy,
  },
} as const;

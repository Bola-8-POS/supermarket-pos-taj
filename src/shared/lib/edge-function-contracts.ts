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
import i18n from './i18n';
import { logger } from './logger';
import { isServerUnreachableStatus } from './resilient-fetch';
import { ok, err, inventoryNegativeError, licenseRefusal, type Result } from './result';
import { supabase, getBackendAnonKey, getBackendUrl, getCachedAccessToken, licenseGuardedFetch } from './supabase';
import type { AppError } from './supabase-contracts';
import { TERMINAL_ID_PATTERN } from './terminal';

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
  /**
   * Offline checkout (two-mode Plan 02b): set only by `buildProvisionalReceipt`
   * on a locally built receipt. `provisionalNumber` is the `P-` number shown
   * instead of a server receipt number. Server responses use
   * {@link ServerReceiptDataSchema}, which strips both.
   */
  provisional: z.boolean().optional(),
  provisionalNumber: z.string().optional(),
});

export type ReceiptData = z.infer<typeof ReceiptDataSchema>;

/**
 * Receipt as a server response may carry it. Omitting the provisional marker
 * here (Zod strips unknown keys) is what guarantees a receipt that came from
 * the server can never print as PROVISIONAL.
 */
export const ServerReceiptDataSchema = ReceiptDataSchema.omit({
  provisional: true,
  provisionalNumber: true,
});

/**
 * `licenseGuardedFetch` rejects with a plain `Error` whose message
 * starts with `LICENSE_LOCKED:` or `LICENSE_RESTRICTED:` (see `supabase.ts`) instead of calling
 * `fetch` at all. None of the seven raw-`fetch` call sites below recognize
 * that prefix on their own — each `catch` block gains one new first line,
 * `const licenseErr = catchToAppError(error); if (licenseErr) return
 * err(licenseErr);`, ahead of its existing `ZodError`/ternary logic, which
 * stays otherwise untouched.
 */
export function catchToAppError(e: unknown): AppError | null {
  return e instanceof Error ? licenseRefusal(e.message) : null;
}

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
    /** Phase 27 Plan 09 (G-27-13): live manager authorization path for `process_payment_atomic`'s DISCOUNT_REQUIRES_MANAGER guard — required (server-side, not by this schema) whenever a discount field is present. `undefined` here must reach the RPC as `false`, never `null`: a NULL boolean satisfies neither `IF p_manager_override THEN` nor `IF NOT p_manager_override THEN` in PL/pgSQL, silently skipping the guard. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08/09 (G-27-13): the approval ticket the manager prompt obtained for managerOverride — the RPC derives the authorizing identity from the ticket, never from the caller's own staff id. */
    approvalId: UuidSchema.optional(),
    /** Id of the staff member who approved the override, as matched by the manager prompt; the RPC checks it together with the ticket. */
    approverId: UuidSchema.optional(),
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
  /** Seconds until the caller's attempt budget unlocks, present only on `PIN_LOCKED`. */
  retryAfter: z.number().int().nonnegative().optional(),
});

/** Successful payload after {@link callProcessPayment} unwraps the edge envelope. */
export const ProcessPaymentSuccessSchema = z.object({
  paymentId: UuidSchema,
  receiptData: ServerReceiptDataSchema,
  idempotent: z.boolean().optional(),
});

export type ProcessPaymentSuccess = z.infer<typeof ProcessPaymentSuccessSchema>;

export const ProcessPaymentEnvelopeSchema = z.object({
  success: z.boolean(),
  paymentId: UuidSchema.optional(),
  receiptData: ServerReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});

/** Exported so it's directly unit-testable — mirrors mapAdminResetPinEdgeError's convention. */
export function mapProcessPaymentEdgeError(
  code: string | undefined,
  message: string,
  retryAfter?: number
): AppError {
  if (code === 'DIRECT_SALE_FAILED' && message.startsWith('INVENTORY_NEGATIVE:')) {
    return inventoryNegativeError(message.slice('INVENTORY_NEGATIVE:'.length).trim());
  }
  // The RPC raises these under a manager override so the spent approval rolls back;
  // the handler then answers DIRECT_SALE_FAILED with the code as the message prefix.
  if (code === 'DIRECT_SALE_FAILED') {
    if (message.startsWith('ZERO_TOTAL_SALE:')) code = 'ZERO_TOTAL_SALE';
    else if (message.startsWith('AMOUNT_MISMATCH:')) code = 'AMOUNT_MISMATCH';
  }
  switch (code) {
    case 'ZERO_TOTAL_SALE':
      return {
        code: 'VALIDATION_ERROR',
        message: i18n.t('wPanels:paymentForm.zeroTotalNotAllowed'),
      };
    case 'PIN_LOCKED':
      return {
        code: 'AUTH_FORBIDDEN',
        message: i18n.t('featOrders:managerPinGate.lockedOut', { seconds: retryAfter ?? 0 }),
      };
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
    // 02d: process_direct_sale_atomic's re-ring guard. The edge code stays in `details`.
    case 'OFFLINE_SALE_WRITTEN_OFF':
      return {
        code: 'VALIDATION_ERROR',
        message: i18n.t('featOrders:reviewOfflineSales.reRingWrittenOff'),
      };
    case 'OFFLINE_SALE_ALREADY_CLOSED':
      return {
        code: 'VALIDATION_ERROR',
        message: i18n.t('featOrders:reviewOfflineSales.reRingAlreadyClosed'),
      };
    case 'RERING_ALREADY_PAID':
      return {
        code: 'VALIDATION_ERROR',
        message: i18n.t('featOrders:reviewOfflineSales.reRingPaidOnServer'),
      };
    case 'RERING_NOT_APPROVED':
      return {
        code: 'VALIDATION_ERROR',
        message: i18n.t('featOrders:reviewOfflineSales.reRingNotApproved'),
      };
    case 'DISCOUNT_REQUIRES_MANAGER':
      return { code: 'DISCOUNT_REQUIRES_MANAGER', message };
    case 'INVALID_DISCOUNT_SCOPE':
      return { code: 'VALIDATION_ERROR', message };
    default:
      // The server's own text never reaches AppError.message unmapped — it
      // is kept in `details` for logs, not shown to the user. The edge code
      // is prefixed too, so an unknown code is still visible in the logs.
      return {
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: `${code ?? 'UNKNOWN'}: ${message}`,
      };
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

    const supabaseUrl = getBackendUrl();
    const supabaseAnonKey = getBackendAnonKey();

    const response = await licenseGuardedFetch(`${supabaseUrl}/functions/v1/process-payment`, {
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
      // Edge function envelope: { success: false, error: { code, message, retryAfter? } }
      const edgeErr =
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error: { code?: unknown; message?: unknown; retryAfter?: unknown } }).error
          : null;
      const edgeCode = typeof edgeErr?.code === 'string' ? edgeErr.code : undefined;
      const edgeMsg =
        typeof edgeErr?.message === 'string'
          ? edgeErr.message
          : `Payment service error (${String(response.status)})`;
      const edgeRetryAfter = typeof edgeErr?.retryAfter === 'number' ? edgeErr.retryAfter : undefined;
      return err(mapProcessPaymentEdgeError(edgeCode, edgeMsg, edgeRetryAfter));
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
        mapProcessPaymentEdgeError(e?.code, e?.message ?? 'Payment could not be completed.', e?.retryAfter)
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
  return { code: 'SUPABASE_ERROR', message: i18n.t('common:edgeErrors.generic'), details: message };
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

    const supabaseUrl = getBackendUrl();
    const supabaseAnonKey = getBackendAnonKey();

    const response = await licenseGuardedFetch(`${supabaseUrl}/functions/v1/create-staff`, {
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
  // Nothing changed server side (the credential write was rolled back): plain retry.
  if (message.startsWith('CREDENTIAL_WRITE_FAILED')) return { code: 'SUPABASE_ERROR', message };
  if (status === 401) return { code: 'AUTH_REQUIRED', message };
  if (status === 403) return { code: 'AUTH_FORBIDDEN', message };
  if (status === 404) return { code: 'NOT_FOUND', message };
  return { code: 'SUPABASE_ERROR', message: i18n.t('common:edgeErrors.generic'), details: message };
}

/**
 * Shared transport for the staff edge functions that require a signed-in
 * caller: raw `fetch` with the cached bearer token and the project key, a
 * flat `{ error: string }` failure envelope, and a zod-checked success body.
 */
async function callStaffEdgeFunction<TRequest, TSuccess>(
  fnName: string,
  request: TRequest,
  requestSchema: z.ZodType<TRequest>,
  successSchema: z.ZodType<TSuccess>,
  mapEdgeError: (status: number, message: string) => AppError,
  fallbackMessage: string
): Promise<Result<TSuccess, AppError>> {
  try {
    const validatedRequest = requestSchema.parse(request);

    const accessToken = getCachedAccessToken();
    if (!accessToken) {
      return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    }

    const supabaseUrl = getBackendUrl();
    const supabaseAnonKey = getBackendAnonKey();

    const response = await licenseGuardedFetch(`${supabaseUrl}/functions/v1/${fnName}`, {
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
          : `${fallbackMessage} (${String(response.status)})`;
      return err(mapEdgeError(response.status, edgeMessage));
    }

    const success = successSchema.safeParse(data);
    if (!success.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unexpected response from staff service',
        details: success.error.message,
      });
    }

    return ok(success.data);
  } catch (error) {
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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

/**
 * Calls the admin-reset-pin edge function.
 *
 * @returns Unwrapped success payload or structured {@link AppError}.
 */
export function callAdminResetPin(
  request: AdminResetPinRequest
): Promise<Result<AdminResetPinSuccess, AppError>> {
  return callStaffEdgeFunction(
    'admin-reset-pin',
    request,
    AdminResetPinRequestSchema,
    AdminResetPinSuccessSchema,
    mapAdminResetPinEdgeError,
    'Could not reset PIN'
  );
}

// ============================================================================
// SET STAFF ACTIVE (staff lifecycle)
// ============================================================================

export const SetStaffActiveRequestSchema = z.object({
  staffId: UuidSchema,
  active: z.boolean(),
  terminalId: z.string().regex(TERMINAL_ID_PATTERN).optional(),
});

export type SetStaffActiveRequest = z.infer<typeof SetStaffActiveRequestSchema>;

export const SetStaffActiveSuccessSchema = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
});

export type SetStaffActiveSuccess = z.infer<typeof SetStaffActiveSuccessSchema>;

/** Exported for unit tests. Flat `{ error: string }` envelope like admin-reset-pin. */
export function mapSetStaffActiveEdgeError(status: number, message: string): AppError {
  if (message.startsWith('PARTIAL_FAILURE')) {
    return { code: 'STAFF_DEACTIVATE_PARTIAL_FAILURE', message };
  }
  if (message === 'LAST_ADMIN') return { code: 'STAFF_LAST_ADMIN', message };
  if (message === 'SELF') return { code: 'STAFF_SELF', message };
  if (status === 401) return { code: 'AUTH_REQUIRED', message };
  if (status === 403) return { code: 'AUTH_FORBIDDEN', message };
  if (status === 404) return { code: 'NOT_FOUND', message };
  return { code: 'SUPABASE_ERROR', message: i18n.t('common:edgeErrors.generic'), details: message };
}

/** Calls the set-staff-active edge function (deactivate or reactivate a staff member). */
export function callSetStaffActive(
  request: SetStaffActiveRequest
): Promise<Result<SetStaffActiveSuccess, AppError>> {
  return callStaffEdgeFunction(
    'set-staff-active',
    request,
    SetStaffActiveRequestSchema,
    SetStaffActiveSuccessSchema,
    mapSetStaffActiveEdgeError,
    'Could not update staff member'
  );
}

// ============================================================================
// CHANGE OWN PIN (forced first-login change)
// ============================================================================

export const ChangeOwnPinRequestSchema = z.object({
  newPin: PinSchema,
  terminalId: z.string().regex(TERMINAL_ID_PATTERN).optional(),
});

export type ChangeOwnPinRequest = z.infer<typeof ChangeOwnPinRequestSchema>;

export const ChangeOwnPinSuccessSchema = z.object({ ok: z.literal(true) });

export type ChangeOwnPinSuccess = z.infer<typeof ChangeOwnPinSuccessSchema>;

/** Exported for unit tests. Flat `{ error: string }` envelope like admin-reset-pin. */
export function mapChangeOwnPinEdgeError(status: number, message: string): AppError {
  if (message.startsWith('PARTIAL_FAILURE')) return { code: 'PIN_CHANGE_PARTIAL_FAILURE', message };
  if (message === 'SAME_PIN') return { code: 'PIN_SAME', message };
  if (status === 401) return { code: 'AUTH_REQUIRED', message };
  if (status === 403) return { code: 'AUTH_FORBIDDEN', message };
  return { code: 'SUPABASE_ERROR', message: i18n.t('common:edgeErrors.generic'), details: message };
}

/** Calls the change-own-pin edge function for the signed-in staff member. */
export function callChangeOwnPin(
  request: ChangeOwnPinRequest
): Promise<Result<ChangeOwnPinSuccess, AppError>> {
  return callStaffEdgeFunction(
    'change-own-pin',
    request,
    ChangeOwnPinRequestSchema,
    ChangeOwnPinSuccessSchema,
    mapChangeOwnPinEdgeError,
    'Could not change PIN'
  );
}

// ============================================================================
// STAFF SIGN-IN
// ============================================================================

export const StaffSignInRequestSchema = z.object({
  staffId: UuidSchema,
  pin: PinSchema,
});

export type StaffSignInRequest = z.infer<typeof StaffSignInRequestSchema>;

export const StaffSignInSuccessSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  mustChangePin: z.boolean(),
});

export type StaffSignInSuccess = z.infer<typeof StaffSignInSuccessSchema>;

/** Exported for unit tests. `details` carries the seconds to wait, as text. */
export function mapStaffSignInEdgeError(status: number, code: string, retryAfter: number): AppError {
  const details = String(retryAfter);
  if (status === 429) return { code: 'AUTH_FORBIDDEN', message: 'LOCKED', details };
  if (status === 401) return { code: 'AUTH_REQUIRED', message: 'INVALID_CREDENTIALS', details };
  return { code: 'SUPABASE_ERROR', message: code };
}

/**
 * Calls the staff-sign-in edge function. Nobody is signed in yet, so the
 * request goes through `functions.invoke`, which sends the project's public key.
 */
export async function callStaffSignIn(
  request: StaffSignInRequest
): Promise<Result<StaffSignInSuccess, AppError>> {
  try {
    const validatedRequest = StaffSignInRequestSchema.parse(request);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- supabase.functions.invoke payload
    const { data, error } = await supabase.functions.invoke<unknown>('staff-sign-in', {
      body: validatedRequest,
    });

    if (error) {
      const context: unknown = (error as { context?: unknown }).context;
      const body: unknown = context instanceof Response ? await context.json().catch(() => null) : null;
      const status = context instanceof Response ? context.status : 0;
      const code =
        body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : getInvokeErrorMessage(error, 'Could not sign in');
      const retryAfter =
        body !== null && typeof body === 'object' && 'retryAfter' in body && typeof body.retryAfter === 'number'
          ? body.retryAfter
          : 0;
      return err(mapStaffSignInEdgeError(status, code, retryAfter));
    }

    const success = StaffSignInSuccessSchema.safeParse(data);
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
      return err({ code: 'VALIDATION_ERROR', message: 'Invalid request data', details: error.message });
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
  retryAfter: z.number().optional(),
});

/**
 * AI and email are the two features that need the internet and a server-side key. CONFIG means
 * the key/sender is not set on this store; RESEND_ERROR / ANTHROPIC_ERROR, or no code
 * at all (the bare 500 these functions give when their upstream is down), mean the server could
 * not reach Anthropic/Resend. INTERNAL is the store's own database failing, so it is not ours either. Any other code (RATE_LIMITED, FORBIDDEN, the gateway's
 * UPSTREAM_UNAVAILABLE / STORE_UPDATING...) returns null: the caller keeps its own mapping. The
 * till's own link to the store server is never "needs internet" (callers pass a non-matching
 * code for a transport failure or a gateway 502/503/504).
 */
export function internetFeatureError(
  feature: 'ai' | 'email',
  code: string | undefined
): AppError | null {
  if (code === 'CONFIG') {
    return {
      code: 'FEATURE_NOT_CONFIGURED',
      message:
        feature === 'ai'
          ? i18n.t('common:edgeErrors.aiNotConfigured')
          : i18n.t('common:edgeErrors.emailNotConfigured'),
    };
  }
  if (
    code === undefined ||
    code === 'RESEND_ERROR' ||
    code === 'ANTHROPIC_ERROR'
  ) {
    return {
      code: 'FEATURE_NEEDS_INTERNET',
      message:
        feature === 'ai'
          ? i18n.t('common:edgeErrors.aiNeedsInternet')
          : i18n.t('common:edgeErrors.emailNeedsInternet')
    };
  }
  return null;
}

/**
 * Exported so it's directly unit-testable — mirrors mapAdminResetPinEdgeError's
 * convention. The three codes agent-proxy's own gates can raise get their
 * own translated messages; everything else falls through to a generic
 * AGENT_ERROR with the server's own text kept only in `details`, never shown
 * to the user.
 */
export function mapAgentProxyErrorBody(
  errBody: { code: string; message: string; retryAfter?: number | undefined } | null,
  responseStatus: number
): AppError {
  if (errBody?.code === 'RATE_LIMITED') {
    return {
      code: 'RATE_LIMITED',
      message: i18n.t('common:edgeErrors.rateLimited', { seconds: errBody.retryAfter ?? 0 }),
    };
  }
  if (errBody?.code === 'FORBIDDEN') {
    return { code: 'AUTH_FORBIDDEN', message: i18n.t('common:edgeErrors.forbidden') };
  }
  if (errBody?.code === 'MODEL_NOT_ALLOWED') {
    return { code: 'MODEL_NOT_ALLOWED', message: i18n.t('common:edgeErrors.modelNotAllowed') };
  }
  // A body-less 502/503/504 is the gateway (till-to-server link), not Anthropic: keep the generic mapping.
  const feature = internetFeatureError(
    'ai',
    errBody
      ? errBody.code
      : responseStatus >= 500 && !isServerUnreachableStatus(responseStatus)
        ? undefined
        : 'OTHER'
  );
  if (feature) return feature;
  const message = errBody?.message ?? `Agent service error (${String(responseStatus)})`;
  return { code: 'AGENT_ERROR', message: i18n.t('common:edgeErrors.generic'), details: message };
}

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

    const supabaseUrl = getBackendUrl();
    const supabaseAnonKey = getBackendAnonKey();

    const response = await licenseGuardedFetch(`${supabaseUrl}/functions/v1/agent-proxy`, {
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
      return err(mapAgentProxyErrorBody(errBody.success ? errBody.data : null, response.status));
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
    /** Per-terminal caja isolation: forwarded as p_terminal_id so the RPC can reject a caja session belonging to another terminal. */
    terminalId: z.string().regex(TERMINAL_ID_PATTERN).optional(),
    /** Phase 27 (PROMO-05/07): manager authorization for the ad-hoc discount and/or the below-cost floor-guard override. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08 (G-27-13): the approval ticket the manager prompt obtained for managerOverride — forwarded to process_direct_sale_atomic, which consumes it. */
    approvalId: UuidSchema.optional(),
    /** Id of the staff member who approved the override, as matched by the manager prompt; the RPC checks it together with the ticket. */
    approverId: UuidSchema.optional(),
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
  receiptData: ServerReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
});

export type ProcessDirectSaleSuccess = z.infer<typeof ProcessDirectSaleSuccessSchema>;

const ProcessDirectSaleEnvelopeSchema = z.object({
  success: z.boolean(),
  tabId: UuidSchema.optional(),
  paymentId: UuidSchema.optional(),
  paymentGroupId: UuidSchema.optional(),
  paymentIds: z.array(UuidSchema).optional(),
  receiptData: ServerReceiptDataSchema.optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});

export async function callProcessDirectSale(
  request: ProcessDirectSaleRequest,
  /** `offlineReplay`: this is the replay of a stored offline sale; lets a `restricted` licence send this one request. */
  opts?: { offlineReplay?: boolean }
): Promise<Result<ProcessDirectSaleSuccess, AppError>> {
  try {
    const validatedRequest = ProcessDirectSaleRequestSchema.parse(request);
    const accessToken = getCachedAccessToken();
    if (!accessToken) return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });

    // The request may reach the server and commit even when the answer never comes back
    // (R3A C2: of 7 sales interrupted mid-flight, 5 had committed). A rejected fetch and a
    // 502/503/504 are therefore "outcome unknown", not "failed": the cashier retries with the
    // SAME key (the persisted, fingerprint-bound one) and the server replays instead of re-selling.
    const outcomeUnknown = (): AppError => ({
      code: 'PAYMENT_OUTCOME_UNKNOWN',
      message: i18n.t('featOrders:checkoutSale.outcomeUnknown'),
    });
    let response: Response;
    try {
      response = await licenseGuardedFetch(
        `${getBackendUrl()}/functions/v1/process-direct-sale`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            apikey: getBackendAnonKey(),
          },
          body: JSON.stringify(validatedRequest),
        },
        opts
      );
    } catch (fetchError) {
      if (fetchError instanceof TypeError) {
        logger.warn('process_direct_sale.outcome_unknown', { reason: 'fetch_failed' });
        return err(outcomeUnknown());
      }
      throw fetchError;
    }
    if (isServerUnreachableStatus(response.status)) {
      logger.warn('process_direct_sale.outcome_unknown', { httpStatus: response.status });
      return err(outcomeUnknown());
    }
    const data: unknown = await response.json().catch(() => null);
    // Final review 4: a 2xx whose body never arrived may still be a committed sale.
    if (response.ok && data === null) {
      logger.warn('process_direct_sale.outcome_unknown', { reason: 'unreadable_body' });
      return err(outcomeUnknown());
    }
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
      // RECEIPT_FETCH: the RPC committed but the receipt reads failed. The sale is recorded;
      // a same-key retry replays it and rebuilds the receipt. The real envelope carries no
      // `message`, so it fails ProcessPaymentErrorBodySchema: read the code from the raw body.
      const rawCode = z.object({ error: z.object({ code: z.string() }) }).safeParse(data);
      if (rawCode.success && rawCode.data.error.code === 'RECEIPT_FETCH') return err(outcomeUnknown());
      const message = edge?.message ?? 'Payment could not be completed.';
      const mapped = mapProcessPaymentEdgeError(edge?.code, message, edge?.retryAfter);
      // The edge code survives the mapping (which folds several codes together) for callers that
      // must tell them apart, e.g. the offline-sale replayer. Log-only, same convention as the
      // mapper's default branch.
      return err(edge ? { ...mapped, details: `${edge.code}: ${edge.message}` } : mapped);
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
  idempotencyKey: UuidSchema.optional(),
});
export const ReceiveShipmentSuccessSchema = z.object({
  shipmentId: UuidSchema,
  idempotent: z.boolean().optional(),
});
export type ReceiveShipmentRequest = z.infer<typeof ReceiveShipmentRequestSchema>;
export type ReceiveShipmentSuccess = z.infer<typeof ReceiveShipmentSuccessSchema>;
const ReceiveShipmentEnvelopeSchema = z.object({
  success: z.boolean(),
  shipmentId: UuidSchema.optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});
export async function callReceiveShipment(
  request: ReceiveShipmentRequest
): Promise<Result<ReceiveShipmentSuccess, AppError>> {
  try {
    const body = ReceiveShipmentRequestSchema.parse(request);
    const accessToken = getCachedAccessToken();
    if (!accessToken) return err({ code: 'AUTH_REQUIRED', message: 'Not authenticated' });
    const response = await licenseGuardedFetch(
      `${getBackendUrl()}/functions/v1/receive-shipment`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          apikey: getBackendAnonKey(),
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
    /** Phase 27 Plan 09 (G-27-13): live manager authorization path for `process_split_payment_atomic`'s DISCOUNT_REQUIRES_MANAGER guard — required (server-side, not by this schema) whenever a discount field is present. `undefined` here must reach the RPC as `false`, never `null`: a NULL boolean satisfies neither `IF p_manager_override THEN` nor `IF NOT p_manager_override THEN` in PL/pgSQL, silently skipping the guard. */
    managerOverride: z.boolean().optional(),
    /** Phase 27 Plan 08/09 (G-27-13): the approval ticket the manager prompt obtained for managerOverride — the RPC derives the authorizing identity from the ticket, never from the caller's own staff id. */
    approvalId: UuidSchema.optional(),
    /** Id of the staff member who approved the override, as matched by the manager prompt; the RPC checks it together with the ticket. */
    approverId: UuidSchema.optional(),
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
  receipts: z.array(ServerReceiptDataSchema).min(1).max(4),
  idempotent: z.boolean().optional(),
});

export type ProcessSplitPaymentSuccess = z.infer<typeof ProcessSplitPaymentSuccessSchema>;

export const ProcessSplitPaymentEnvelopeSchema = z.object({
  success: z.boolean(),
  paymentGroupId: UuidSchema.optional(),
  paymentIds: z.array(UuidSchema).optional(),
  receipts: z.array(ServerReceiptDataSchema).optional(),
  idempotent: z.boolean().optional(),
  error: ProcessPaymentErrorBodySchema.optional(),
});

/** Exported so it's directly unit-testable — mirrors mapAdminResetPinEdgeError's convention. */
export function mapProcessSplitPaymentEdgeError(
  code: string | undefined,
  message: string,
  retryAfter?: number
): AppError {
  switch (code) {
    case 'PIN_LOCKED':
      return {
        code: 'AUTH_FORBIDDEN',
        message: i18n.t('featOrders:managerPinGate.lockedOut', { seconds: retryAfter ?? 0 }),
      };
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
      // The edge code is prefixed onto details too, so an unknown code is
      // still visible in the logs.
      return {
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: `${code ?? 'UNKNOWN'}: ${message}`,
      };
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

    const supabaseUrl = getBackendUrl();
    const supabaseAnonKey = getBackendAnonKey();

    const response = await licenseGuardedFetch(`${supabaseUrl}/functions/v1/process-split-payment`, {
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
      // Edge function envelope: { success: false, error: { code, message, retryAfter? } }
      const edgeErr =
        data !== null && typeof data === 'object' && 'error' in data
          ? (data as { error: { code?: unknown; message?: unknown; retryAfter?: unknown } }).error
          : null;
      const edgeCode = typeof edgeErr?.code === 'string' ? edgeErr.code : undefined;
      const edgeMsg =
        typeof edgeErr?.message === 'string'
          ? edgeErr.message
          : `Payment service error (${String(response.status)})`;
      const edgeRetryAfter = typeof edgeErr?.retryAfter === 'number' ? edgeErr.retryAfter : undefined;
      return err(mapProcessSplitPaymentEdgeError(edgeCode, edgeMsg, edgeRetryAfter));
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
        mapProcessSplitPaymentEdgeError(
          e?.code,
          e?.message ?? 'Payment could not be completed.',
          e?.retryAfter
        )
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
    const licenseErr = catchToAppError(error);
    if (licenseErr) return err(licenseErr);

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
      // fail()'s RATE_LIMITED and FORBIDDEN reach the client through the
      // real response body behind supabase-js's generic error, not through
      // the always-successful `data` path below.
      const invokeErr = await getInvokeErrorBody(error, 'Could not send receipt email');
      const feature = internetFeatureError('email', featureCodeOf(invokeErr));
      if (feature && invokeErr.code !== 'RATE_LIMITED' && invokeErr.code !== 'FORBIDDEN') {
        return err({ ...feature, details: invokeErr.message });
      }
      if (invokeErr.code === 'RATE_LIMITED') {
        return err({
          code: 'RATE_LIMITED',
          message: i18n.t('common:edgeErrors.rateLimited', { seconds: invokeErr.retryAfter ?? 0 }),
        });
      }
      if (invokeErr.code === 'FORBIDDEN') {
        return err({ code: 'AUTH_FORBIDDEN', message: i18n.t('common:edgeErrors.forbidden') });
      }
      return err({
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: invokeErr.message,
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
      const feature = internetFeatureError('email', e?.code);
      if (feature) return err(feature);
      return err({
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: e?.message ?? e?.code ?? 'Failed to send receipt email',
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

/**
 * `getInvokeErrorMessage` only ever sees the supabase-js SDK's own
 * generic "Edge Function returned a non-2xx status code" string — it never
 * reads the real response body. `error.context` is the raw `Response` when
 * the edge function actually answered (the working precedent is
 * `callStaffSignIn`'s own body-read at line ~672); this reads it and pulls
 * `{ code, message, retryAfter }` out of the function's own `nested`/`ok`
 * envelope shape (`{ success | ok: false, error: { code, message, ... } }`),
 * falling back to `getInvokeErrorMessage`'s generic string when there is no
 * `context` at all (a genuine network failure with no HTTP response).
 */
async function getInvokeErrorBody(
  error: unknown,
  fallback: string
): Promise<{
  code?: string | undefined;
  message: string;
  retryAfter?: number | undefined;
  status?: number | undefined;
}> {
  const context: unknown = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) {
    return { message: getInvokeErrorMessage(error, fallback) };
  }
  const body: unknown = await context.json().catch(() => null);
  const nested =
    body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'object' && body.error !== null
      ? (body as { error: { code?: unknown; message?: unknown; retryAfter?: unknown } }).error
      : null;
  return {
    code: typeof nested?.code === 'string' ? nested.code : undefined,
    message: typeof nested?.message === 'string' ? nested.message : getInvokeErrorMessage(error, fallback),
    retryAfter: typeof nested?.retryAfter === 'number' ? nested.retryAfter : undefined,
    status: context.status,
  };
}

/**
 * The code to feed `internetFeatureError` for a failed function call. No response at all (the till
 * could not reach its server) and a gateway 502/503/504 are the till-to-server link, so they get a
 * code that is never "needs internet"; a real function answer keeps its own (possibly absent) code.
 */
function featureCodeOf(invokeErr: { code?: string | undefined; status?: number | undefined }): string | undefined {
  if (invokeErr.status === undefined) return 'TRANSPORT';
  if (invokeErr.code === undefined) {
    // No nested code: a 5xx the function itself gave (bare 500) is ours; a gateway 502/503/504 or a
    // 4xx (expired JWT 401, 404 not deployed, 413) is not an Anthropic/Resend problem.
    if (isServerUnreachableStatus(invokeErr.status)) return 'GATEWAY';
    if (invokeErr.status < 500) return 'CLIENT_ERROR';
  }
  return invokeErr.code;
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
        message: i18n.t('common:edgeErrors.generic'),
        details: envelope.data.error?.message ?? 'Restore failed',
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
      // A FORBIDDEN role-gate refusal reaches the client through the real
      // response body behind supabase-js's generic error.
      const invokeErr = await getInvokeErrorBody(error, 'Could not check email status');
      if (invokeErr.code === 'FORBIDDEN') {
        return err({ code: 'AUTH_FORBIDDEN', message: i18n.t('common:edgeErrors.forbidden') });
      }
      return err({
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: invokeErr.message,
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
        message: i18n.t('common:edgeErrors.generic'),
        details: envelope.data.error?.message ?? 'Could not check email status',
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
      const invokeErr = await getInvokeErrorBody(error, 'Could not send test email');
      const feature = internetFeatureError('email', featureCodeOf(invokeErr));
      if (feature) return err({ ...feature, details: invokeErr.message });
      if (invokeErr.code === 'FORBIDDEN') {
        return err({ code: 'AUTH_FORBIDDEN', message: i18n.t('common:edgeErrors.forbidden') });
      }
      return err({
        code: 'SUPABASE_ERROR',
        message: i18n.t('common:edgeErrors.generic'),
        details: invokeErr.message,
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
      return err(
        internetFeatureError('email', envelope.data.error?.code) ?? {
          code: 'SUPABASE_ERROR',
          message: i18n.t('common:edgeErrors.generic'),
          details: envelope.data.error?.message ?? 'Could not send test email',
        }
      );
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

/**
 * RESULT TYPE â€” Core Error Handling Infrastructure
 *
 * This is the MOST IMPORTANT foundation file. Every async operation in the app
 * returns Result<T, E>. This prevents inconsistent error handling patterns.
 *
 * A Result is either success (ok: true, has data) or failure (ok: false, has error).
 * This forces explicit error handling at every call site.
 *
 * Inspired by Rust's Result<T, E> type.
 *
 * @example CORRECT usage â€” always check result.ok before using data
 * ```typescript
 * const result = await supabaseQuery(() =>
 *   supabase.from('tabs').select('*').eq('id', tabId).single()
 * )
 *
 * if (!result.ok) {
 *   logger.error('tab.fetch.failed', { code: result.error.code })
 *   toast.error(result.error.message)
 *   return
 * }
 *
 * const tab = result.data // typed as TabRow, not null
 * ```
 */

import type { PostgrestError } from '@supabase/supabase-js';

// ============================================================================
// RESULT TYPE
// ============================================================================

/**
 * Result type representing either success or failure.
 *
 * - Success: { ok: true, data: T }
 * - Failure: { ok: false, error: E }
 */
export type Result<T, E = AppError> = { ok: true; data: T } | { ok: false; error: E };

// ============================================================================
// HELPER CONSTRUCTORS
// ============================================================================

/**
 * Creates a successful Result.
 *
 * @param data - The success value
 * @returns Result with ok: true
 *
 * @example
 * ```typescript
 * const result = ok({ id: '123', name: 'John' })
 * if (result.ok) {
 *   console.log(result.data.name)
 * }
 * ```
 */
export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });

/**
 * Creates a failed Result.
 *
 * @param error - The error value
 * @returns Result with ok: false
 *
 * @example
 * ```typescript
 * const result = err({ code: 'NOT_FOUND', message: 'User not found' })
 * if (!result.ok) {
 *   console.error(result.error.message)
 * }
 * ```
 */
export const err = <E = AppError>(error: E): Result<never, E> => ({ ok: false, error });

// ============================================================================
// RESULT UTILITIES
// ============================================================================

/**
 * Transform the data inside a Result without unwrapping.
 *
 * If the Result is ok, applies the function to the data.
 * If the Result is err, passes through the error unchanged.
 *
 * @param result - The Result to transform
 * @param fn - Function to apply to the data
 * @returns New Result with transformed data or original error
 *
 * @example
 * ```typescript
 * const result = ok(5)
 * const doubled = mapResult(result, x => x * 2)
 * // doubled = ok(10)
 *
 * const error = err({ code: 'NOT_FOUND', message: 'Not found' })
 * const mapped = mapResult(error, x => x * 2)
 * // mapped = err({ code: 'NOT_FOUND', message: 'Not found' })
 * ```
 */
export const mapResult = <T, U, E>(result: Result<T, E>, fn: (data: T) => U): Result<U, E> => {
  if (result.ok) {
    return ok(fn(result.data));
  }
  return result;
};

/**
 * Unwrap a Result or throw an error.
 *
 * USE SPARINGLY â€” only when you're certain the Result is ok.
 * Prefer checking result.ok explicitly in most cases.
 *
 * @param result - The Result to unwrap
 * @returns The data if ok
 * @throws Error if the Result is err
 *
 * @example
 * ```typescript
 * const result = ok(42)
 * const value = unwrapResult(result) // 42
 *
 * const error = err({ code: 'NOT_FOUND', message: 'Not found' })
 * unwrapResult(error) // throws Error
 * ```
 */
export const unwrapResult = <T, E>(result: Result<T, E>): T => {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`Attempted to unwrap an error Result: ${JSON.stringify(result.error)}`);
};

/**
 * Checks if a Result is successful.
 *
 * @param result - The Result to check
 * @returns True if the Result is ok
 */
export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; data: T } => {
  return result.ok;
};

/**
 * Checks if a Result is an error.
 *
 * @param result - The Result to check
 * @returns True if the Result is err
 */
export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } => {
  return !result.ok;
};

// ============================================================================
// APP ERROR TYPE
// ============================================================================

/**
 * Application error codes.
 *
 * These represent all possible error states in the application.
 */
export type AppErrorCode =
  | 'NETWORK_OFFLINE'
  | 'AUTH_REQUIRED'
  | 'AUTH_FORBIDDEN' // has auth but not enough permissions
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE_ENTRY'
  | 'TAB_ALREADY_CLOSED'
  | 'TAB_NOT_OPEN' // action requires an open tab (e.g. item removal on a closed/voided tab)
  | 'SESSION_STILL_RUNNING' // trying to close tab with active pool session
  | 'PAYMENT_DECLINED'
  | 'PAYMENT_ALREADY_PROCESSED'
  | 'PAYMENT_OUTCOME_UNKNOWN' // the checkout answer was lost (502/503/504 or a dropped connection): the sale may already be recorded, so retry with the same idempotency key
  | 'INVENTORY_NEGATIVE'
  | 'CAJA_CLOSED'
  | 'OPEN_TABS_EXIST'
  | 'POOL_TABLE_OCCUPIED'
  | 'COMBO_UNAVAILABLE' // Combo not available at this day/time
  | 'SLOT_MIN_MAX_VIOLATION' // Slot selection qty outside min..max
  | 'INVALID_CHILD' // Child product not combo_eligible or not in slot options
  | 'NESTED_COMBO_FORBIDDEN' // Attempting to nest a combo inside another combo
  | 'SUPABASE_ERROR'
  | 'STORE_CONFIG_INVALID' // this till's store.env was refused (unreadable, unknown mode, rejected URL): no backend is used until it is repaired
  | 'SERVER_UNREACHABLE' // HTTP 502/503/504 from the backend gateway: the request may or may not have been applied
  | 'FEATURE_NOT_CONFIGURED' // an internet feature (AI, email) whose server-side key/sender is not set on this store
  | 'FEATURE_NEEDS_INTERNET' // an internet feature whose upstream (Anthropic, Resend) could not be reached
  | 'TAURI_ERROR'
  | 'PRINT_BROKER_UNREACHABLE' // store-local print broker did not respond within the connect-timeout window
  | 'PRINT_JOB_REJECTED' // broker rejected the job (auth/payload/persistence 4xx/5xx)
  | 'PRINT_JOB_UNKNOWN' // broker marked the job status 'unknown' (ambiguous WinSpool handoff) — needs manual confirm, never auto-resubmit
  | 'EXPORT_CANCELLED'
  | 'EXPORT_FAILED'
  | 'PARENT_TAB_PAID' // parent tab already paid — cannot split
  | 'ITEM_NOT_IN_PARENT' // order item does not belong to parent tab
  | 'ITEM_ASSIGNED_TWICE' // same item assigned to two sub-tabs
  | 'UNASSIGNED_ITEMS' // split completed but some items were not assigned
  | 'REFUND_EXCEEDS_ORIGINAL' // refund amount > original payment amount
  | 'ITEM_NOT_IN_ORIGINAL_ORDER' // refund item not found in original order
  | 'PREP_INGREDIENT_REQUIRED' // prep batch attempted on a non-prep ingredient
  | 'WAITLIST_ENTRY_NOT_FOUND'
  | 'WAITLIST_NOTIFICATION_RATE_LIMITED'
  | 'WAITLIST_INVALID_PHONE'
  | 'AGENT_ERROR'
  | 'SERVER_UPDATE_REQUIRED' // two-mode 02c: the database has no resolve_offline_sale yet
  | 'RAG_ERROR'
  | 'TOOL_EXECUTION_ERROR'
  | 'STALE_VERSION' // row was updated by another terminal since last read
  | 'NOT_FOUND_VERSIONED' // row missing under FOR UPDATE in versioned RPC
  | 'BELOW_COST_REQUIRES_OVERRIDE' // Phase 27 (PROMO-07): combined discounts would sell below cost; needs manager PIN override
  | 'DISCOUNT_REQUIRES_MANAGER' // Phase 27 (PROMO-05): ad-hoc discount submitted without manager authorization
  | 'PHOTO_TOO_LARGE' // Phase 31: photo file exceeds MAX_UPLOAD_BYTES pre-resize
  | 'PHOTO_DECODE_FAILED' // Phase 31: createImageBitmap could not decode the file (Pitfall 5 — mislabeled/unsupported bytes)
  | 'PHOTO_UPLOAD_FAILED' // Phase 31: the Storage upload call itself failed
  | 'PHOTO_LINK_FAILED' // Phase 31: object uploaded but products.photo_path write failed (Pitfall 6)
  | 'PHOTO_REMOVE_FAILED' // Phase 31 Plan 04: the Storage delete or the products.photo_path clear failed
  | 'LICENSE_LOCKED' // licensing: terminal is locked (unlicensed/invalid/suspended/demo) — writes to the DB are refused
  | 'STORE_SCHEMA_MISMATCH' // two-mode 07b: the store server is at a different schema level than this build — writes are held
  | 'LICENSE_RESTRICTED' // licensing: lease/subscription/offline budget ran out — only close-out writes are allowed
  | 'LICENSE_ERROR' // licensing: license server rejected activation/heartbeat (bad key, revoked, terminal limit)
  | 'STORE_FROZEN' // two-mode switch: the cloud store is frozen while it moves to its own server - writes are refused
  | 'STORE_MOVED' // two-mode switch: the store moved to its own server - this till must be paired
  | 'INVALID_DELTA' // adjust_inventory: quantity delta is zero/null
  | 'INVALID_REASON' // adjust_inventory: reason is blank
  | 'STOCK_CHANGED' // adjust_inventory: p_expected_quantity no longer matches the row (concurrent change)
  | 'CAJA_SESSION_NOT_OPEN' // process_refund: the named p_caja_session_id is not an open session
  | 'OFFLINE_SALES_PENDING' // close caja / clock-out / sign-out refused: offline sales are not confirmed yet
  | 'LIST_CHANGED' // a paged list kept changing while it was read; the caller keeps its last good copy
  | 'UNKNOWN_ERROR';

/**
 * Application error type.
 *
 * - code: Machine-readable error code
 * - message: Human-readable message (safe to show to user)
 * - detail: Technical detail (log only, never show to user)
 * - raw: Underlying error (for logging, never expose to UI)
 */
export type AppError = {
  code: AppErrorCode;
  message: string;
  detail?: string;
  raw?: unknown;
};

// ============================================================================
// ERROR FACTORY FUNCTIONS
// ============================================================================

/**
 * Creates a network offline error.
 */
export const networkOfflineError = (): AppError => ({
  code: 'NETWORK_OFFLINE',
  message: 'No internet connection. Working offline.',
});

/** The wire code resilient-fetch stamps on an unreachable /rest/v1/ answer; parseSupabaseError maps it to SERVER_UNREACHABLE. */
export const SERVER_UNREACHABLE_CODE = 'SERVER_UNREACHABLE';

/**
 * The backend answered 502/503/504: it was not reachable, or its own
 * dependencies were down. The outcome of the request is unknown — callers must hold and
 * retry, never treat it as a hard failure.
 */
export const serverUnreachableError = (): AppError => ({
  code: 'SERVER_UNREACHABLE',
  message: 'The server could not be reached. Try again in a moment.',
});

/** The store.env of an Offline-only till was refused: nothing may be sent anywhere until it is repaired (Plan 11's repair screen). */
export const storeConfigInvalidError = (code: string): AppError => ({
  code: 'STORE_CONFIG_INVALID',
  message: "This till's store configuration is invalid. Ask the store manager to repair it.",
  detail: code,
});

/**
 * Creates an authentication required error.
 */
export const authRequiredError = (): AppError => ({
  code: 'AUTH_REQUIRED',
  message: 'Please log in to continue.',
});

/**
 * Creates an authorization forbidden error.
 *
 * @param requiredRole - The role required for the action
 */
export const authForbiddenError = (requiredRole: string): AppError => ({
  code: 'AUTH_FORBIDDEN',
  message: `This action requires ${requiredRole} access.`,
});

/**
 * Creates a not found error.
 *
 * @param resource - The resource that was not found
 */
export const notFoundError = (resource: string = 'Record'): AppError => ({
  code: 'NOT_FOUND',
  message: `${resource} not found.`,
});

/**
 * Creates a validation error.
 *
 * @param fields - Map of field names to error messages
 */
export const validationError = (fields: Record<string, string>): AppError => ({
  code: 'VALIDATION_ERROR',
  message: 'Please check the highlighted fields.',
  detail: JSON.stringify(fields),
});

/**
 * Creates a duplicate entry error.
 *
 * @param field - The field that has a duplicate value
 */
export const duplicateEntryError = (field: string = 'entry'): AppError => ({
  code: 'DUPLICATE_ENTRY',
  message: `This ${field} already exists.`,
});

/**
 * Creates a tab already closed error.
 */
export const tabAlreadyClosedError = (): AppError => ({
  code: 'TAB_ALREADY_CLOSED',
  message: 'This tab has already been closed.',
});

/**
 * Creates a tab-not-open error.
 * Raised when an action requiring an open tab (e.g. item removal via
 * `remove_tab_item`) targets a closed/voided tab (RPC code `TAB_NOT_OPEN`).
 */
export const tabNotOpenError = (): AppError => ({
  code: 'TAB_NOT_OPEN',
  message: 'This tab is no longer open.',
});

/**
 * Creates a session still running error.
 *
 * @param tableNumber - The pool table number with active session
 */
export const sessionStillRunningError = (tableNumber: number): AppError => ({
  code: 'SESSION_STILL_RUNNING',
  message: `Pool Table #${String(tableNumber)} timer is still running. Stop it before closing this tab.`,
});

/**
 * Creates a payment declined error.
 *
 * @param reason - Optional reason for decline
 */
export const paymentDeclinedError = (reason?: string): AppError => ({
  code: 'PAYMENT_DECLINED',
  message: 'Payment was declined.',
  ...(reason !== undefined && { detail: reason }),
});

/**
 * Creates a payment already processed error.
 */
export const paymentAlreadyProcessedError = (): AppError => ({
  code: 'PAYMENT_ALREADY_PROCESSED',
  message: 'This payment has already been processed.',
});

/**
 * Creates an inventory negative error.
 *
 * @param productName - The product that would go negative
 */
export const inventoryNegativeError = (productName: string): AppError => ({
  code: 'INVENTORY_NEGATIVE',
  message: `Cannot complete order: ${productName} is out of stock.`,
});

/**
 * Creates a Supabase error.
 *
 * @param message - Error message
 * @param detail - Technical detail
 * @param raw - Original Supabase error
 */
export const supabaseError = (message: string, detail?: string, raw?: unknown): AppError => ({
  code: 'SUPABASE_ERROR',
  message,
  ...(detail !== undefined && { detail }),
  ...(raw !== undefined && { raw }),
});

/**
 * Creates a Tauri error.
 *
 * @param message - Error message
 * @param raw - Original Tauri error
 */
export const tauriError = (message: string, raw?: unknown): AppError => ({
  code: 'TAURI_ERROR',
  message,
  ...(raw !== undefined && { raw }),
});

/**
 * Creates an export cancelled error (user dismissed the save dialog).
 */
export const exportCancelledError = (): AppError => ({
  code: 'EXPORT_CANCELLED',
  message: 'Export cancelled.',
});

/**
 * Creates an export failed error.
 *
 * @param detail - Technical detail about what failed
 * @param raw - Underlying error
 */
export const exportFailedError = (detail?: string, raw?: unknown): AppError => ({
  code: 'EXPORT_FAILED',
  message: 'Export failed. Please try again.',
  ...(detail !== undefined && { detail }),
  ...(raw !== undefined && { raw }),
});

/**
 * Creates a photo-too-large error (Phase 31, D-11).
 *
 * @param sizeMb - Offending file size in megabytes, formatted to one decimal place
 */
export const photoTooLargeError = (sizeMb: string): AppError => ({
  code: 'PHOTO_TOO_LARGE',
  message: 'Photo exceeds the maximum upload size.',
  detail: sizeMb,
});

/**
 * Creates a photo-decode-failed error (Phase 31, Pitfall 5).
 *
 * @param type - Offending declared MIME type, or 'unknownType' when File.type is empty
 */
export const photoDecodeFailedError = (type: string): AppError => ({
  code: 'PHOTO_DECODE_FAILED',
  message: 'Could not decode the image file.',
  detail: type,
});

/**
 * Creates a photo-upload-failed error (Phase 31) — the Storage upload call itself failed.
 */
export const photoUploadFailedError = (detail?: string, raw?: unknown): AppError => ({
  code: 'PHOTO_UPLOAD_FAILED',
  message: 'Photo upload failed.',
  ...(detail !== undefined && { detail }),
  ...(raw !== undefined && { raw }),
});

/**
 * Creates a photo-link-failed error (Phase 31, Pitfall 6) — the object uploaded but
 * `products.photo_path` could not be updated.
 */
export const photoLinkFailedError = (detail?: string, raw?: unknown): AppError => ({
  code: 'PHOTO_LINK_FAILED',
  message: "The photo uploaded but couldn't be linked to the product.",
  ...(detail !== undefined && { detail }),
  ...(raw !== undefined && { raw }),
});

/**
 * Creates a photo-remove-failed error (Phase 31 Plan 04) — the Storage
 * delete or the `products.photo_path` clear failed; the photo stays in
 * place so the operator can retry.
 */
export const photoRemoveFailedError = (detail?: string, raw?: unknown): AppError => ({
  code: 'PHOTO_REMOVE_FAILED',
  message: "Couldn't remove the photo.",
  ...(detail !== undefined && { detail }),
  ...(raw !== undefined && { raw }),
});

/**
 * Creates an unknown error.
 *
 * @param raw - Original error
 */
export const unknownError = (raw?: unknown): AppError => ({
  code: 'UNKNOWN_ERROR',
  message: 'An unexpected error occurred.',
  ...(raw !== undefined && { raw }),
});

/** A paged list kept changing while it was read: treated like a transport failure (last good data is kept). */
export const listChangedError = (message: string): AppError => ({ code: 'LIST_CHANGED', message });

/**
 * Creates a stale-version conflict error.
 * Raised when a versioned RPC detects expected_version mismatch (SQLSTATE P0V01),
 * OR when a Group-B hook UPDATE with .eq('version', expected) returns 0 rows (PGRST116).
 */
export const staleVersionError = (raw?: unknown): AppError => ({
  code: 'STALE_VERSION',
  message: 'Updated by another terminal — please retry',
  ...(raw !== undefined && { raw }),
});

/**
 * Creates a not-found-under-FOR-UPDATE error (SQLSTATE P0V02).
 * Toast copy approved verbatim 2026-04-28.
 */
export const notFoundVersionedError = (raw?: unknown): AppError => ({
  code: 'NOT_FOUND_VERSIONED',
  message: 'Record was deleted by another terminal.',
  ...(raw !== undefined && { raw }),
});

// ============================================================================
// SUPABASE ERROR PARSING
// ============================================================================

/**
 * Parses a Supabase PostgrestError into an AppError.
 *
 * Maps Supabase error codes to user-friendly messages.
 *
 * @param error - The Supabase error
 * @returns Application error
 */
/**
 * licenseGuardedFetch's refusals ('LICENSE_LOCKED: …' / 'LICENSE_RESTRICTED: …' / 'STORE_SCHEMA_MISMATCH: …'), raw or wrapped
 * by postgrest-js as 'Error: …', as a typed AppError carrying only the readable message.
 */
export function licenseRefusal(message: string): AppError | null {
  for (const code of ['LICENSE_LOCKED', 'LICENSE_RESTRICTED', 'STORE_SCHEMA_MISMATCH'] as const) {
    const at = message.indexOf(`${code}:`);
    if (at !== -1) return { code, message: message.slice(at + code.length + 1).trim() };
  }
  return null;
}

/**
 * The hosted fence's refusals (`STORE_FROZEN: ...` raised by the guard trigger, `STORE_MOVED: ...` raised by the same
 * trigger or by licenseGuardedFetch), raw or wrapped by postgrest-js as 'Error: ...' or by an RPC as 'DIRECT_SALE_FAILED: ...'.
 */
export function storeSwitchRefusal(message: string): AppError | null {
  // Anchored: a code quoted mid-message (a product name) is not a refusal. Mirrored in connectivity.ts and _shared/upstream.ts.
  const m = /^(?:Error: )?(?:[A-Z_]+_FAILED: )?(STORE_FROZEN|STORE_MOVED):/.exec(message);
  const code = m?.[1] as 'STORE_FROZEN' | 'STORE_MOVED' | undefined;
  return code && m ? { code, message: message.slice(m[0].length).trim() } : null;
}

export const parseSupabaseError = (error: PostgrestError): AppError => {
  // licenseGuardedFetch (supabase.ts) rejects with a plain Error, not a PostgrestError — the
  // supabase-js fetch layer re-wraps it into this shape but only preserves `.message`, so this
  // is the one place that string reaches a typed AppErrorCode.
  const refusal = licenseRefusal(error.message);
  if (refusal) return refusal;
  const storeSwitch = storeSwitchRefusal(error.message);
  if (storeSwitch) return storeSwitch;

  if (error.code === SERVER_UNREACHABLE_CODE) {
    return serverUnreachableError();
  }

  const code = error.code || 'UNKNOWN';

  // Unique constraint violation
  if (code === '23505') {
    return duplicateEntryError();
  }

  // Foreign key constraint violation
  if (code === '23503') {
    return supabaseError('Invalid reference to related record', error.details, error);
  }

  // Not null constraint violation
  if (code === '23502') {
    return supabaseError('Required field is missing', error.details, error);
  }

  // Row not found (PostgREST specific)
  if (code === 'PGRST116') {
    return notFoundError();
  }

  // Row-level security violation
  if (code === '42501') {
    return authForbiddenError('appropriate');
  }

  // Optimistic concurrency conflict (Phase 15)
  if (code === 'P0V01') {
    return staleVersionError(error);
  }
  if (code === 'P0V02') {
    return notFoundVersionedError(error);
  }

  // Check constraint violation
  if (code === '23514') {
    return validationError({ _general: error.message });
  }

  // Default: generic Supabase error
  return supabaseError(error.message || 'Database error', error.details, error);
};

// ============================================================================
// SUPABASE RESULT WRAPPER
// ============================================================================

/**
 * Wraps any Supabase query into a Result type.
 *
 * Handles network errors, Supabase errors, and null data.
 *
 * @param queryFn - Function that returns a Supabase query promise
 * @returns Result with data or error
 *
 * @example
 * ```typescript
 * const result = await supabaseQuery(() =>
 *   supabase.from('tabs').select('*').eq('id', tabId).single()
 * )
 *
 * if (!result.ok) {
 *   console.error(result.error.message)
 *   return
 * }
 *
 * console.log(result.data) // typed as TabRow
 * ```
 */
export async function supabaseQuery<T>(
  queryFn: () => PromiseLike<{ data: T | null; error: PostgrestError | null }>
): Promise<Result<T>> {
  try {
    const { data, error } = await queryFn();

    if (error) {
      return err(parseSupabaseError(error));
    }

    if (data === null) {
      return err(notFoundError());
    }

    return ok(data);
  } catch (e) {
    // Check for network offline
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return err(networkOfflineError());
    }

    // Unknown error
    return err(unknownError(e));
  }
}

/**
 * Wraps a Supabase mutation (insert/update/delete) into a Result type.
 *
 * Unlike supabaseQuery, this allows null data (for operations that don't return data).
 *
 * @param mutationFn - Function that returns a Supabase mutation promise
 * @returns Result with data or error
 *
 * @example
 * ```typescript
 * const result = await supabaseMutation(() =>
 *   supabase.from('tabs').update({ status: 'closed' }).eq('id', tabId)
 * )
 *
 * if (!result.ok) {
 *   console.error(result.error.message)
 *   return
 * }
 *
 * console.log('Tab closed successfully')
 * ```
 */
export async function supabaseMutation<T>(
  mutationFn: () => PromiseLike<{ data: T | null; error: PostgrestError | null }>
): Promise<Result<T | null>> {
  try {
    const { data, error } = await mutationFn();

    if (error) {
      return err(parseSupabaseError(error));
    }

    return ok(data);
  } catch (e) {
    // Check for network offline
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return err(networkOfflineError());
    }

    // Unknown error
    return err(unknownError(e));
  }
}

/**
 * Wraps a version-guarded Supabase UPDATE (`.eq('version', expected)`) into a
 * Result<void>, treating a zero-row match as a stale-version conflict.
 *
 * PostgREST returns HTTP 204 with no body for an UPDATE that matches zero
 * rows — callers MUST append a `.select(...)` projection to the update
 * chain, or the zero-row (stale version) case degrades to the current silent
 * no-op behavior instead of surfacing `STALE_VERSION`.
 *
 * @param mutationFn - Function returning a Supabase mutation promise whose
 *   update chain ends with `.select(...)` so `data` reflects matched rows.
 * @returns `ok(undefined)` when at least one row matched, `err(staleVersionError())`
 *   when zero rows matched (null or empty array), or the parsed Supabase
 *   error unchanged for any other failure.
 */
export async function versionedMutation(
  mutationFn: () => PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>
): Promise<Result<void>> {
  const result = await supabaseMutation<unknown[]>(mutationFn);

  if (!result.ok) {
    return result;
  }

  if (result.data === null || result.data.length === 0) {
    return err(staleVersionError());
  }

  return ok(undefined);
}

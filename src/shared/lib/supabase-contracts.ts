/**
 * SUPABASE CONTRACTS
 *
 * Historically defined the shape of every Supabase query this app makes,
 * extending the auto-generated supabase.types.ts with typed query result
 * shapes. Those typed-query-result helpers (Database placeholder,
 * SupabaseQueryResult, the *WithOrders/*WithDetails row shapes, their type
 * guards, SUPABASE_ERROR_CODES, parseSupabaseError, isSupabaseError,
 * hasError, hasData) were removed 2026-08-06 (Phase 39 Plan 11) as confirmed
 * dead — zero importers anywhere in src/ or supabase/functions/, superseded
 * by the real AppErrorCode-based error handling in `./result.ts`.
 *
 * `AppError` below is the one export from this file still consumed
 * elsewhere (payment-processor.ts, email-receipt.ts,
 * edge-function-contracts.ts) — a legacy, loosely-typed error shape
 * distinct from `./result.ts`'s `AppError`/`AppErrorCode`.
 */

// ============================================================================
// APPLICATION ERROR TYPE
// ============================================================================

/**
 * Application-level error type.
 * Maps Supabase errors to user-friendly messages.
 */
export type AppError = {
  code: string;
  message: string;
  details?: string;
  hint?: string;
};

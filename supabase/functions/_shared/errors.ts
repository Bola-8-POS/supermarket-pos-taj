// Shared error envelope for edge functions. fail() builds the right
// response shape for the calling function's family and keeps raw server
// text (a Postgres/Auth error's own .message) out of every response body;
// only opts.detail reaches the server log.
import { corsHeaders } from './cors.ts'

export type Envelope = 'nested' | 'flat' | 'ok'

export interface FailOpts {
  envelope: Envelope
  message?: string
  detail?: unknown
  extra?: Record<string, unknown>
}

// One fixed English default per code. opts.message overrides it when a
// function needs its own wording (most RPC-raised codes pass their own
// literal message straight through instead — see publicRpcMessage below).
const DEFAULT_MESSAGES: Record<string, string> = {
  METHOD_NOT_ALLOWED: 'Method not allowed',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Insufficient permissions',
  VALIDATION_ERROR: 'Invalid request',
  CONFIG: 'Server misconfigured',
  INVALID_JSON: 'Body must be JSON',
  NOT_FOUND: 'Not found',
  RATE_LIMITED: 'Too many requests, try again later',
  INTERNAL: 'Something went wrong',
  SUPABASE_ERROR: 'Request failed',
  RPC_ERROR: 'Request failed',
  DB_ERROR: 'Request failed',
  PAYMENT_FAILED: 'Payment failed',
  PAYMENT_FETCH: 'Could not load payment',
  TAB_FETCH: 'Could not load tab',
  ORDERS_FETCH: 'Could not load orders',
  RECEIPT_FETCH: 'Could not load receipt',
  DIRECT_SALE_FAILED: 'Sale could not be processed',
  RECEIVE_SHIPMENT_FAILED: 'Shipment could not be received',
  RESTORE_FAILED: 'Restore failed',
  RESEND_ERROR: 'Could not send email',
  AUTH_WRITE_FAILED: 'Credential update failed',
  PROFILE_WRITE_FAILED: 'Staff record update failed, retry',
  MODEL_NOT_ALLOWED: 'Model not allowed',
  ANTHROPIC_ERROR: 'Upstream error',
}

// The three RPC-raised codes whose message is actually SQLERRM-sourced and
// so can carry raw database detail. Every other RPC code's message is our
// own literal text and passes through fail() unscrubbed.
const RAW_TEXT_CODES = new Set(['DIRECT_SALE_FAILED', 'INTERNAL', 'RECEIVE_SHIPMENT_FAILED'])

// Every distinct RAISE EXCEPTION '<PREFIX>:' prefix in supabase/migrations
// as of this wave (re-grepped from `RAISE EXCEPTION '[A-Z_]+:` — re-run this
// grep before trusting the list stale).
const RPC_OWN_PREFIXES = [
  'AUTH_FORBIDDEN:',
  'AUTH_REQUIRED:',
  'BANK_TRANSFER_CODE_SPACE_EXHAUSTED:',
  'COMBO_UNAVAILABLE:',
  'DIRECT_SALE_PAYMENT_FAILED:',
  'DUPLICATE_ENTRY:',
  'FORBIDDEN:',
  'INGREDIENT_NOT_FOUND:',
  'INVALID_CHILD:',
  'INVALID_DELTA:',
  'INVALID_REASON:',
  'INVENTORY_NEGATIVE:',
  'ITEM_ASSIGNED_TWICE:',
  'ITEM_NOT_IN_ORIGINAL_ORDER:',
  'ITEM_NOT_IN_PARENT:',
  'NESTED_COMBO_FORBIDDEN:',
  'NOT_FOUND:',
  'NO_OPEN_CAJA:',
  'NO_ORDER_FOUND:',
  'PARENT_TAB_PAID:',
  'PAYMENT_ALREADY_PROCESSED:',
  'PERMISSION_DENIED:',
  'PIN_LOCKED:',
  'PREP_INGREDIENT_REQUIRED:',
  'REFUND_AMOUNT_EXCEEDS_LINE:',
  'REFUND_EXCEEDS_ORIGINAL:',
  'REFUND_ITEM_INVALID:',
  'REFUND_QTY_EXCEEDS_LINE:',
  'SEAT_START_SESSION_FAILED:',
  'SLOT_MIN_MAX_VIOLATION:',
  'STOCK_CHANGED:',
  'VALIDATION_ERROR:',
]

// Scrubs an RPC-sourced message before it reaches the client. Only the three
// SQLERRM-carrying codes are ever scrubbed, and only when the message does
// not start with one of our own raised prefixes; every other code's message
// (our own literal text, e.g. CAJA_CLOSED -> 'Caja session is not open')
// passes through unchanged.
export function publicRpcMessage(code: string, message: string | undefined): string {
  if (!message) return DEFAULT_MESSAGES[code] ?? 'Request failed'
  if (!RAW_TEXT_CODES.has(code)) return message
  if (RPC_OWN_PREFIXES.some((prefix) => message.startsWith(prefix))) return message
  console.error(`publicRpcMessage: scrubbed message for ${code}`, message)
  return DEFAULT_MESSAGES[code] ?? 'Request failed'
}

export function fail(req: Request, status: number, code: string, opts: FailOpts): Response {
  if (opts.detail !== undefined) {
    console.error(`[${code}]`, opts.detail)
  }
  const message = opts.message ?? DEFAULT_MESSAGES[code] ?? 'Request failed'

  let body: unknown
  switch (opts.envelope) {
    case 'nested':
      body = { success: false, error: { code, message, ...opts.extra } }
      break
    case 'flat':
      body = { error: code, ...opts.extra }
      break
    case 'ok':
      body = { ok: false, error: { code, message, ...opts.extra } }
      break
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  })
}

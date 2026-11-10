import { fail, publicRpcMessage } from './errors.ts'
// Tells "the backend is unreachable or going away" apart from a real answer, for the money functions. A request that dies
// inside an RPC or a post-commit read may already have committed, so it must read as outcome-unknown (503, retry under the
// same idempotency key), never as a definite 500 the till would show as failed. fail() turns every 503 into
// UPSTREAM_UNAVAILABLE + Retry-After. Real business errors (a SQLSTATE or PGRST1xx+ code with a message) keep their codes.

export interface PgLikeError {
  code?: string | null
  message?: string | null
}

export class UpstreamUnavailableError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'UpstreamUnavailableError'
  }
}

export function isUpstreamFailure(error: PgLikeError | null | undefined, status?: number): boolean {
  if (status === 502 || status === 503 || status === 504) return true
  if (!error) return false
  const code = error.code ?? ''
  if (code === '') return true // a real PostgREST/Postgres error always carries a code: none means no usable answer
  if (code === 'UPSTREAM_UNAVAILABLE' || /^PGRST00[0-3]$/.test(code)) return true
  // connection exceptions (class 08), admin shutdown / crash recovery (57P01-03), too many connections
  return code.startsWith('08') || /^57P0[1-3]$/.test(code) || code === '53300'
}

/** Throws UpstreamUnavailableError when any of the results failed for an upstream reason; a business error is left to the caller. */
export function throwIfUpstream(...results: Array<{ error: PgLikeError | null; status?: number }>): void {
  for (const r of results) {
    if (isUpstreamFailure(r.error, r.status)) throw new UpstreamUnavailableError(r.error?.message ?? `status ${String(r.status)}`)
  }
}

/** The failure answer for a failed call: 503 (outcome unknown, retry) for an upstream reason, else the function's own 500 code. */
export function failUnlessUpstream(req: Request, code: string, error: PgLikeError | null | undefined, status?: number): Response {
  const detail = error?.message ?? undefined
  // The hosted fence's refusal, raised (not wrapped) by the guard trigger: surface it, the till holds its queue on it.
  const fence = /^(?:Error: )?(?:[A-Z_]+_FAILED: )?(STORE_FROZEN|STORE_MOVED):/.exec(error?.message ?? '')
  if (fence && !isUpstreamFailure(error, status)) {
    return fail(req, 409, fence[1], { envelope: 'nested', message: error?.message?.slice(fence[0].length - fence[1].length - 1), detail })
  }
  return isUpstreamFailure(error, status)
    ? fail(req, 503, 'UPSTREAM_UNAVAILABLE', { envelope: 'nested', detail })
    : fail(req, 500, code, { envelope: 'nested', detail })
}

/** failUnlessUpstream, but an RPC raise starting with one of `refusals` ('CODE:') is a definite 409 refusal carrying that code. */
export function failRpcRefusalUnlessUpstream(req: Request, code: string, error: PgLikeError, refusals: readonly string[]): Response {
  const refusal = isUpstreamFailure(error) ? undefined : refusals.find(r => error.message?.startsWith(`${r}:`))
  return refusal
    ? fail(req, 409, refusal, { envelope: 'nested', message: publicRpcMessage(refusal, error.message ?? undefined) })
    : failUnlessUpstream(req, code, error)
}

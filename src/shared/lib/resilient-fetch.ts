/**
 * Response shaping around the fetch supabase-js receives (`global.fetch`). Pure helpers plus
 * one composer; no state. Two reasons it exists, both from the two-mode spikes (R3A/S2B):
 *
 *  1. postgrest-js drops the HTTP status and, for a non-JSON error body, produces
 *     `{ message: <body> }` with no code. A 502/503/504 therefore looks exactly like a generic
 *     database error, and the offline queue dead-letters work it should have held. Tagging the
 *     body with a typed code lets `parseSupabaseError` surface `SERVER_UNREACHABLE`.
 *  2. auth-js deletes the session on any refresh error other than 502/503/504, so a transient
 *     refresh failure (429, other 5xx) is reported as a 503 and the cashier stays signed in.
 */
import { SERVER_UNREACHABLE_CODE } from './result';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function isServerUnreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function pathOf(input: RequestInfo | URL): string {
  // The base is only used for a relative URL; supabase-js always passes an absolute one.
  return new URL(urlOf(input), 'http://localhost').pathname;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

/** The POST that exchanges a refresh token (`/auth/v1/token?grant_type=refresh_token`). */
export function isAuthRefreshRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (methodOf(input, init) !== 'POST') return false;
  const url = new URL(urlOf(input), 'http://localhost');
  return url.pathname.endsWith('/auth/v1/token') && url.searchParams.get('grant_type') === 'refresh_token';
}

/**
 * auth-js (2.103.0) removes the session, and so signs the cashier out, on any refresh error
 * except a rejected fetch and HTTP 502/503/504 (`auth-js/src/lib/fetch.ts:38`,
 * `GoTrueClient.ts:4624`). A transient refusal (429 from GoTrue's per-IP limiter, or any other
 * 5xx such as the 500 GoTrue returns while Postgres is down, R3A C4-2) is not a verdict on the
 * session. Report it as a 503 so auth-js keeps the session and retries on its 30 s tick.
 * 400/401/403/422 are real refusals (revoked, reused, banned) and pass through untouched.
 */
export function softenRefreshResponse(res: Response): Response {
  const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
  if (!transient || isServerUnreachableStatus(res.status)) return res;
  return new Response(res.body, { status: 503, statusText: 'Service Unavailable', headers: res.headers });
}

/**
 * Rewrites an unreachable PostgREST answer into a PostgREST-shaped JSON error carrying
 * SERVER_UNREACHABLE_CODE, preserving the status. "Unreachable" is 502/503/504 only. A 400 is
 * never rewritten: R3A C4-2's 400 carried a JSON body (no empty-bodied 400 was ever observed), so
 * a 400 is a real verdict and must never mean "hold" or "outcome unknown".
 */
export function markUnreachableRestResponse(res: Response): Promise<Response> {
  if (!isServerUnreachableStatus(res.status)) return Promise.resolve(res);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        code: SERVER_UNREACHABLE_CODE,
        message: `Server unreachable (HTTP ${String(res.status)})`,
        details: null,
        hint: null,
      }),
      {
        status: res.status,
        statusText: res.statusText,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  );
}

export function withResilientResponses(base: FetchFn): FetchFn {
  return async (input, init) => {
    const res = await base(input, init);
    if (isAuthRefreshRequest(input, init)) return softenRefreshResponse(res);
    if (pathOf(input).includes('/rest/v1/')) return markUnreachableRestResponse(res);
    return res;
  };
}

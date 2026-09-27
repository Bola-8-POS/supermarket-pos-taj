// Edge-side wrapper for the rate_limit_hit RPC. Callers turn a false `ok`
// into a 500 (the counter itself is unavailable) and a positive retryAfter
// into a 429 via _shared/errors.ts's fail() with `extra: { retryAfter }`.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type RateLimitResult = { ok: true; retryAfter: number } | { ok: false }

export async function rateLimit(
  admin: SupabaseClient,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const { data, error } = await admin.rpc('rate_limit_hit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  })
  if (error || typeof data !== 'number') {
    console.error('rateLimit: rate_limit_hit failed', key, error?.message ?? 'no data returned')
    return { ok: false }
  }
  return { ok: true, retryAfter: data }
}

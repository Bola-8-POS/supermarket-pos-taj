import { z } from 'zod';

import type { ServerConfig } from './server-config';

const SuccessSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  mustChangePin: z.boolean(),
});

export type SignInResult =
  | { kind: 'ok'; accessToken: string; refreshToken: string; mustChangePin: boolean }
  | { kind: 'INVALID_CREDENTIALS' }
  | { kind: 'LOCKED'; retryAfter: number }
  | { kind: 'UNAVAILABLE' }
  | { kind: 'MUST_CHANGE_PIN' };

const DEFAULT_RETRY_AFTER = 60;
const REQUEST_TIMEOUT_MS = 10_000;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function retryAfterSeconds(body: unknown): number {
  const raw = typeof body === 'object' && body !== null ? (body as { retryAfter?: unknown }).retryAfter : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : DEFAULT_RETRY_AFTER;
}

/** Pure: config and fetch are injected. Never throws, never returns raw server text. */
export async function callStaffSignIn(
  config: ServerConfig,
  staffId: string,
  pin: string,
  fetchFn: typeof fetch
): Promise<SignInResult> {
  let res: Response;
  const controller = new AbortController();
  // React Native fetch has no timeout of its own.
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    res = await fetchFn(`${config.url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
      },
      body: JSON.stringify({ staffId, pin }),
      signal: controller.signal,
    });
  } catch {
    return { kind: 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    // Only the function's own 401 is a wrong PIN; a gateway 401 (bad/rotated key) never checked it.
    const body = await readJson(res);
    const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return code === 'INVALID_CREDENTIALS' ? { kind: 'INVALID_CREDENTIALS' } : { kind: 'UNAVAILABLE' };
  }
  if (res.status === 429) return { kind: 'LOCKED', retryAfter: retryAfterSeconds(await readJson(res)) };
  if (res.status !== 200) return { kind: 'UNAVAILABLE' };

  const parsed = SuccessSchema.safeParse(await readJson(res));
  return parsed.success ? { kind: 'ok', ...parsed.data } : { kind: 'UNAVAILABLE' };
}

/** What the UI sees: never carries tokens. */
export type StaffSignInOutcome = Exclude<SignInResult, { kind: 'ok' }> | { kind: 'ok' };

type SessionAuth = {
  setSession: (session: { access_token: string; refresh_token: string }) => Promise<{ error: unknown }>;
};

/**
 * Pure orchestration: call the function, then hand tokens to the client only when the
 * sign-in is complete. A must-change-PIN sign-in never reaches setSession, so no session
 * is stored and no SIGNED_IN event fires.
 */
export async function completeStaffSignIn(
  config: ServerConfig,
  staffId: string,
  pin: string,
  deps: { fetchFn: typeof fetch; auth: SessionAuth }
): Promise<StaffSignInOutcome> {
  const result = await callStaffSignIn(config, staffId, pin, deps.fetchFn);
  if (result.kind !== 'ok') return result;
  if (result.mustChangePin) return { kind: 'MUST_CHANGE_PIN' };
  try {
    const { error } = await deps.auth.setSession({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    });
    return error ? { kind: 'UNAVAILABLE' } : { kind: 'ok' };
  } catch {
    return { kind: 'UNAVAILABLE' };
  }
}

export function signInMessage(result: Exclude<SignInResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'INVALID_CREDENTIALS':
      return 'Wrong PIN.';
    case 'LOCKED': {
      const n = result.retryAfter;
      if (n < 60) return `Too many attempts. Try again in ${n} ${n === 1 ? 'second' : 'seconds'}.`;
      const m = Math.ceil(n / 60);
      return `Too many attempts. Try again in ${m} ${m === 1 ? 'minute' : 'minutes'}.`;
    }
    case 'MUST_CHANGE_PIN':
      return 'Your PIN must be changed first. Change it in the POS app, then sign in here.';
    case 'UNAVAILABLE':
      return 'Sign-in is unavailable right now. Try again shortly.';
  }
}

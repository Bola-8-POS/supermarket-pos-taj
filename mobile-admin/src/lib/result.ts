// Mirror of the desktop's src/shared/lib/result.ts, trimmed to what the mobile app uses.
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: unknown): Result<T> => ({
  ok: false,
  error: error instanceof Error ? error.message : typeof error === 'string' ? error : String(error),
});

/** Unwrap inside a React Query fn: throws so useQuery exposes `error`. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new Error(r.error);
}

// A staff PIN lives in two stores: the Auth password and profiles.pin (a
// bcrypt hash since 11H, hashed by the profiles trigger). This writes both as
// one operation. Default order (change-own-pin): profile first, then Auth; the
// profile is the store whose old value is known verbatim (the stored hash), so
// when Auth fails the previous stored values are written back as they were (a
// `$2` value passes the trigger unchanged). Auth-first order (admin reset):
// Auth, then profile; the old Auth password cannot be re-derived from a hash,
// so a profile failure after Auth succeeded is PARTIAL_FAILURE and the admin
// retries; the old PIN can never keep signing in. Thrown errors from either
// writer follow the same failure paths. Pure logic over injected writers, so
// credentials_test.ts covers every outcome with fakes.

export type WriteError = { message: string } | null

export interface CredentialDeps {
  setPassword(userId: string, pin: string): Promise<{ error: WriteError }>
  updateProfile(userId: string, patch: Record<string, unknown>): Promise<{ error: WriteError }>
  /** After a failed profile write: does the row already hold the patch values? Optional. */
  profileHolds?(userId: string, patch: Record<string, unknown>): Promise<boolean>
}

export interface CredentialArgs {
  userId: string
  newPin: string
  profilePatch: Record<string, unknown>
  /** The stored profile values before this write, restored verbatim on an Auth failure. */
  previousProfile: { pin: string; must_change_pin: boolean }
  /** 'profile-first' (default) restores the profile on an Auth failure; 'auth-first' never restores Auth. */
  order?: 'profile-first' | 'auth-first'
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; code: 'COMPENSATED' | 'PARTIAL_FAILURE'; message: string }

async function safe(f: () => Promise<{ error: WriteError }>): Promise<{ error: WriteError }> {
  try {
    return await f()
  } catch (e) {
    return { error: { message: e instanceof Error ? e.message : 'write threw' } }
  }
}

// A failed write may still have landed (lost response): re-read once and, when
// the row already holds the values, count it as written; otherwise one retry.
async function writeProfile(deps: CredentialDeps, userId: string, patch: Record<string, unknown>) {
  const first = await safe(() => deps.updateProfile(userId, patch))
  if (!first.error) return first
  if (deps.profileHolds) {
    try {
      if (await deps.profileHolds(userId, patch)) return { error: null }
    } catch { /* unknown: fall through to the retry */ }
  }
  return await safe(() => deps.updateProfile(userId, patch))
}

export async function writeCredential(deps: CredentialDeps, args: CredentialArgs): Promise<CredentialResult> {
  const setAuth = () => safe(() => deps.setPassword(args.userId, args.newPin))

  if (args.order === 'auth-first') {
    const auth = await setAuth()
    // Nothing was written anywhere.
    if (auth.error) return { ok: false, code: 'COMPENSATED', message: auth.error.message }
    const profile = await writeProfile(deps, args.userId, args.profilePatch)
    if (profile.error) return { ok: false, code: 'PARTIAL_FAILURE', message: profile.error.message }
    return { ok: true }
  }

  const profile = await writeProfile(deps, args.userId, args.profilePatch)
  // Nothing was written anywhere: Auth is never called.
  if (profile.error) return { ok: false, code: 'COMPENSATED', message: profile.error.message }

  const auth = await setAuth()
  if (!auth.error) return { ok: true }

  const restore = await writeProfile(deps, args.userId, args.previousProfile)
  if (restore.error) {
    return { ok: false, code: 'PARTIAL_FAILURE', message: `${auth.error.message}; ${restore.error.message}` }
  }
  return { ok: false, code: 'COMPENSATED', message: auth.error.message }
}

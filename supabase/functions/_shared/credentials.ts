// A staff PIN lives in two stores: the Auth password and profiles.pin. This
// writes both as one operation: Auth first, then the profile (one retry);
// when the profile write still fails the previous Auth password is restored.
// Pure logic over two injected writers, so credentials_test.ts covers every
// outcome with fakes.

export type WriteError = { message: string } | null

export interface CredentialDeps {
  setPassword(userId: string, pin: string): Promise<{ error: WriteError }>
  updateProfile(userId: string, patch: Record<string, unknown>): Promise<{ error: WriteError }>
}

export interface CredentialArgs {
  userId: string
  previousPin: string
  newPin: string
  profilePatch: Record<string, unknown>
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; code: 'AUTH_WRITE_FAILED' | 'COMPENSATED' | 'PARTIAL_FAILURE'; message: string }

export async function writeCredential(deps: CredentialDeps, args: CredentialArgs): Promise<CredentialResult> {
  const auth = await deps.setPassword(args.userId, args.newPin)
  if (auth.error) return { ok: false, code: 'AUTH_WRITE_FAILED', message: auth.error.message }

  let profile = await deps.updateProfile(args.userId, args.profilePatch)
  if (profile.error) profile = await deps.updateProfile(args.userId, args.profilePatch)
  if (!profile.error) return { ok: true }

  const restore = await deps.setPassword(args.userId, args.previousPin)
  if (restore.error) {
    return { ok: false, code: 'PARTIAL_FAILURE', message: `${profile.error.message}; ${restore.error.message}` }
  }
  return { ok: false, code: 'COMPENSATED', message: profile.error.message }
}

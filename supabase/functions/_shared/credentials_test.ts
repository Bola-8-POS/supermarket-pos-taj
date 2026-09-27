// deno test supabase/functions/_shared/credentials_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { type CredentialDeps, writeCredential } from './credentials.ts'

const fail = (message: string) => ({ error: { message } })
const okWrite = { error: null }

const args = { userId: 'u1', previousPin: 'old', newPin: 'new', profilePatch: { pin: 'new' } }

// Records every call so each test can assert the order and the arguments.
function fakes(plan: { password?: Array<{ error: { message: string } | null }>; profile?: Array<{ error: { message: string } | null }> }) {
  const calls: string[] = []
  const password = [...(plan.password ?? [])]
  const profile = [...(plan.profile ?? [])]
  const deps: CredentialDeps = {
    setPassword: (_id, pin) => {
      calls.push(`password:${pin}`)
      return Promise.resolve(password.shift() ?? okWrite)
    },
    updateProfile: (_id, _patch) => {
      calls.push('profile')
      return Promise.resolve(profile.shift() ?? okWrite)
    },
  }
  return { deps, calls }
}

Deno.test('success: Auth then profile, nothing else', async () => {
  const { deps, calls } = fakes({})
  assertEquals(await writeCredential(deps, args), { ok: true })
  assertEquals(calls, ['password:new', 'profile'])
})

Deno.test('AUTH_WRITE_FAILED: the profile is never touched', async () => {
  const { deps, calls } = fakes({ password: [fail('auth down')] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'AUTH_WRITE_FAILED', message: 'auth down' })
  assertEquals(calls, ['password:new'])
})

Deno.test('retry then success: one profile retry, no compensation', async () => {
  const { deps, calls } = fakes({ profile: [fail('blip')] })
  assertEquals(await writeCredential(deps, args), { ok: true })
  assertEquals(calls, ['password:new', 'profile', 'profile'])
})

Deno.test('COMPENSATED: the previous Auth password is restored after the retry fails', async () => {
  const { deps, calls } = fakes({ profile: [fail('db down'), fail('db down')] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'db down' })
  assertEquals(calls, ['password:new', 'profile', 'profile', 'password:old'])
})

Deno.test('PARTIAL_FAILURE: compensation itself fails', async () => {
  const { deps, calls } = fakes({ password: [okWrite, fail('auth down')], profile: [fail('db down'), fail('db down')] })
  assertEquals(await writeCredential(deps, args), {
    ok: false,
    code: 'PARTIAL_FAILURE',
    message: 'db down; auth down',
  })
  assertEquals(calls, ['password:new', 'profile', 'profile', 'password:old'])
})

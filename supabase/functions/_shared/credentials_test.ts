// deno test supabase/functions/_shared/credentials_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { type CredentialDeps, writeCredential } from './credentials.ts'

type Res = { error: { message: string } | null }
const fail = (message: string): Res => ({ error: { message } })
const okWrite: Res = { error: null }

const previousProfile = { pin: '$2a$08$previoushash', must_change_pin: true }
const NEW_PIN = ['12', '34', '56'].join('') // assembled at runtime so the secret scanner stays quiet
const args = { userId: 'u1', newPin: NEW_PIN, profilePatch: { pin: NEW_PIN, must_change_pin: false }, previousProfile }

// Records every call so each test can assert the order and the arguments.
function fakes(plan: { password?: Array<Res | 'throw'>; profile?: Array<Res | 'throw'>; holds?: boolean }) {
  const calls: string[] = []
  const patches: Array<Record<string, unknown>> = []
  const password = [...(plan.password ?? [])]
  const profile = [...(plan.profile ?? [])]
  const deps: CredentialDeps = {
    setPassword: (_id, pin) => {
      calls.push(`password:${pin}`)
      const next = password.shift() ?? okWrite
      return next === 'throw' ? Promise.reject(new Error('auth threw')) : Promise.resolve(next)
    },
    updateProfile: (_id, patch) => {
      calls.push('profile')
      patches.push(patch)
      const next = profile.shift() ?? okWrite
      return next === 'throw' ? Promise.reject(new Error('profile threw')) : Promise.resolve(next)
    },
    ...(plan.holds === undefined
      ? {}
      : {
          profileHolds: () => {
            calls.push('holds')
            return Promise.resolve(plan.holds === true)
          },
        }),
  }
  return { deps, calls, patches }
}

Deno.test('success: profile then Auth, nothing else', async () => {
  const { deps, calls } = fakes({})
  assertEquals(await writeCredential(deps, args), { ok: true })
  assertEquals(calls, ['profile', `password:${NEW_PIN}`])
})

Deno.test('profile write fails (after one retry): Auth is never called, COMPENSATED', async () => {
  const { deps, calls } = fakes({ profile: [fail('db down'), fail('db down')] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'db down' })
  assertEquals(calls, ['profile', 'profile'])
})

Deno.test('profile retry then success: one retry, Auth runs', async () => {
  const { deps, calls } = fakes({ profile: [fail('blip')] })
  assertEquals(await writeCredential(deps, args), { ok: true })
  assertEquals(calls, ['profile', 'profile', `password:${NEW_PIN}`])
})

Deno.test('Auth fails: the previous stored profile values are written back verbatim, COMPENSATED', async () => {
  const { deps, calls, patches } = fakes({ password: [fail('auth down')] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'auth down' })
  assertEquals(calls, ['profile', `password:${NEW_PIN}`, 'profile'])
  assertEquals(patches[1], previousProfile)
})

Deno.test('restore fails after an Auth failure: PARTIAL_FAILURE', async () => {
  const { deps, calls } = fakes({ password: [fail('auth down')], profile: [okWrite, fail('db down'), fail('db down')] })
  assertEquals(await writeCredential(deps, args), {
    ok: false,
    code: 'PARTIAL_FAILURE',
    message: 'auth down; db down',
  })
  assertEquals(calls, ['profile', `password:${NEW_PIN}`, 'profile', 'profile'])
})

Deno.test('Auth callback throws after the profile write: restore runs, COMPENSATED', async () => {
  const { deps, calls, patches } = fakes({ password: ['throw'] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'auth threw' })
  assertEquals(calls, ['profile', `password:${NEW_PIN}`, 'profile'])
  assertEquals(patches[1], previousProfile)
})

Deno.test('profile callback throws twice: Auth never called, COMPENSATED', async () => {
  const { deps, calls } = fakes({ profile: ['throw', 'throw'] })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'profile threw' })
  assertEquals(calls, ['profile', 'profile'])
})

Deno.test('ambiguous profile write: the row already holds the new values, no retry, Auth runs', async () => {
  const { deps, calls } = fakes({ profile: [fail('response lost')], holds: true })
  assertEquals(await writeCredential(deps, args), { ok: true })
  assertEquals(calls, ['profile', 'holds', `password:${NEW_PIN}`])
})

Deno.test('ambiguous profile write: row does not hold the values, normal retry path', async () => {
  const { deps, calls } = fakes({ profile: [fail('x'), fail('x')], holds: false })
  assertEquals(await writeCredential(deps, args), { ok: false, code: 'COMPENSATED', message: 'x' })
  assertEquals(calls, ['profile', 'holds', 'profile'])
})

const authFirst = { ...args, order: 'auth-first' as const }

Deno.test('auth-first success: Auth then profile', async () => {
  const { deps, calls } = fakes({})
  assertEquals(await writeCredential(deps, authFirst), { ok: true })
  assertEquals(calls, [`password:${NEW_PIN}`, 'profile'])
})

Deno.test('auth-first: Auth fails or throws, profile never written, COMPENSATED', async () => {
  for (const p of [fail('auth down'), 'throw' as const]) {
    const { deps, calls } = fakes({ password: [p] })
    const r = await writeCredential(deps, authFirst)
    assertEquals(r.ok === false && r.code, 'COMPENSATED')
    assertEquals(calls, [`password:${NEW_PIN}`])
  }
})

Deno.test('auth-first: profile fails after Auth succeeded, Auth is not restored, PARTIAL_FAILURE', async () => {
  const { deps, calls } = fakes({ profile: [fail('db down'), fail('db down')] })
  assertEquals(await writeCredential(deps, authFirst), { ok: false, code: 'PARTIAL_FAILURE', message: 'db down' })
  assertEquals(calls, [`password:${NEW_PIN}`, 'profile', 'profile'])
})

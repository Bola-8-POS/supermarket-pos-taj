// deno test --allow-env supabase/functions/_shared/staff-password_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { deriveStaffPassword, StaffPasswordConfigError, staffPasswordPepper } from './staff-password.ts'

// Test-only secret. The same vectors are pinned in src/shared/lib/__tests__/staff-password-parity.test.ts.
const PEPPER = 'test-pepper-not-secret-0123456789abcdef'
const ID = '00000000-0000-4000-8000-000000000001'

Deno.test('known answer: the same vector as the Node twin', async () => {
  assertEquals(await deriveStaffPassword(ID, '123456', PEPPER), 'v1.b-KxtbzaJ3Kj4qtelqO7EIC7CiCPzzZmWEW4T7b0afg')
})

Deno.test('a different PIN or staff id gives a different password', async () => {
  assertEquals(await deriveStaffPassword(ID, '654321', PEPPER), 'v1.06cJj2ek2d7hSpbiXnLIVW1MJaULMx0nH8qlDnyY1mM')
  assertEquals(
    await deriveStaffPassword('00000000-0000-4000-8000-000000000002', '123456', PEPPER),
    'v1.Ky3kYhaVTh0FuBRUP6kqZxqAzKdEWWPJ35k1wcI69Vc',
  )
})

Deno.test('staff id case does not matter', async () => {
  assertEquals(
    await deriveStaffPassword('ABCDEF00-0000-4000-8000-0000000000AB', '123456', PEPPER),
    'v1.Bt3Ec0OO3HlVZ1xK7K76_nzC7MsWf7e1zZt-2Fk_RP8',
  )
})

Deno.test('fits bcrypt: 46 characters, under the 72-byte limit', async () => {
  assertEquals((await deriveStaffPassword(ID, '123456', PEPPER)).length, 46)
})

Deno.test('refuses a missing, short or low-entropy secret', async () => {
  await assertRejects(() => deriveStaffPassword(ID, '123456', null), StaffPasswordConfigError)
  await assertRejects(() => deriveStaffPassword(ID, '123456', 'short'), StaffPasswordConfigError)
  // 64 characters long but one repeated character: what a failed generator leaves behind.
  await assertRejects(() => deriveStaffPassword(ID, '123456', '0'.repeat(64)), StaffPasswordConfigError)
  // Two symbols only: still far too few distinct characters.
  await assertRejects(() => deriveStaffPassword(ID, '123456', 'ab'.repeat(32)), StaffPasswordConfigError)
})

Deno.test('accepts every correctly generated 64-character hex pepper (the floor is 8 distinct characters)', async () => {
  // Hex has only 16 symbols, so a 64-character hex string almost never has fewer than 8 distinct ones.
  for (let i = 0; i < 2000; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const pepper = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    assertEquals((await deriveStaffPassword(ID, '123456', pepper)).length, 46)
  }
})

Deno.test('refuses a malformed staff id or PIN', async () => {
  await assertRejects(() => deriveStaffPassword('not-a-uuid', '123456', PEPPER), TypeError)
  await assertRejects(() => deriveStaffPassword(ID, '12345', PEPPER), TypeError)
  await assertRejects(() => deriveStaffPassword(ID, '12345a', PEPPER), TypeError)
})

Deno.test('reads the secret from STAFF_PASSWORD_PEPPER and refuses a short or low-entropy one', () => {
  const previous = Deno.env.get('STAFF_PASSWORD_PEPPER')
  try {
    Deno.env.delete('STAFF_PASSWORD_PEPPER')
    assertEquals(staffPasswordPepper(), null)
    Deno.env.set('STAFF_PASSWORD_PEPPER', 'short')
    assertEquals(staffPasswordPepper(), null)
    Deno.env.set('STAFF_PASSWORD_PEPPER', '0'.repeat(64))
    assertEquals(staffPasswordPepper(), null)
    Deno.env.set('STAFF_PASSWORD_PEPPER', PEPPER)
    assertEquals(staffPasswordPepper(), PEPPER)
  } finally {
    if (previous === undefined) Deno.env.delete('STAFF_PASSWORD_PEPPER')
    else Deno.env.set('STAFF_PASSWORD_PEPPER', previous)
  }
})

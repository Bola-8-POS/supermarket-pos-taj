// deno test --allow-env supabase/functions/_shared/store-header_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { type HeaderReader, resolveStoreHeader } from './store-header.ts'

const reader = (result: { data: { value?: unknown } | null; error?: unknown } | 'throw'): HeaderReader => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => (result === 'throw' ? Promise.reject(new Error('down')) : Promise.resolve(result)),
      }),
    }),
  }),
})
const env = (vars: Record<string, string>) => (n: string) => vars[n]

Deno.test('settings win over the secrets', async () => {
  const out = await resolveStoreHeader(
    reader({ data: { value: { storeName: 'Tienda Sol', address: 'Calle 1' } } }),
    env({ BAR_NAME: 'Secret', BAR_ADDRESS: 'Secret St' }),
  )
  assertEquals(out, { storeName: 'Tienda Sol', barAddress: 'Calle 1' })
})

Deno.test('a blank or whitespace store name falls back to the secret, then to Supermarket POS', async () => {
  const blank = reader({ data: { value: { storeName: '   ', address: 'A' } } })
  assertEquals((await resolveStoreHeader(blank, env({ BAR_NAME: 'Secret' }))).storeName, 'Secret')
  assertEquals((await resolveStoreHeader(blank, env({}))).storeName, 'Supermarket POS')
  assertEquals((await resolveStoreHeader(blank, env({ BAR_NAME: ' ' }))).storeName, 'Supermarket POS')
})

Deno.test('a missing general row or a read error uses the secrets', async () => {
  const vars = env({ BAR_NAME: 'Secret', BAR_ADDRESS: 'Secret St' })
  const expected = { storeName: 'Secret', barAddress: 'Secret St' }
  assertEquals(await resolveStoreHeader(reader({ data: null }), vars), expected)
  assertEquals(await resolveStoreHeader(reader({ data: null, error: { message: 'x' } }), vars), expected)
  assertEquals(await resolveStoreHeader(reader('throw'), vars), expected)
})

Deno.test('name and address fall back independently', async () => {
  const out = await resolveStoreHeader(
    reader({ data: { value: { storeName: 'Tienda Sol', address: '' } } }),
    env({ BAR_NAME: 'Secret', BAR_ADDRESS: 'Secret St' }),
  )
  assertEquals(out, { storeName: 'Tienda Sol', barAddress: 'Secret St' })
  const out2 = await resolveStoreHeader(reader({ data: { value: { address: 'Calle 1' } } }), env({ BAR_NAME: 'Secret' }))
  assertEquals(out2, { storeName: 'Secret', barAddress: 'Calle 1' })
})

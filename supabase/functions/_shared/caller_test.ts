// deno test --allow-env supabase/functions/_shared/caller_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2'
import { callerHasAction } from './caller.ts'

// A minimal stub of the one chain callerHasAction calls
// (.from().select().eq().eq().maybeSingle()) -- the query result is the
// only thing under test here, not the client itself.
function stubClient(result: { data: { id: string } | null; error: { message: string } | null }): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: () => Promise.resolve(result) }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

Deno.test('a matching role_permissions row returns true', async () => {
  const admin = stubClient({ data: { id: 'row-1' }, error: null })
  assertEquals(await callerHasAction(admin, 'admin', 'manage_staff'), true)
})

Deno.test('no matching row returns false', async () => {
  const admin = stubClient({ data: null, error: null })
  assertEquals(await callerHasAction(admin, 'cashier', 'manage_staff'), false)
})

Deno.test('a query error returns false', async () => {
  const admin = stubClient({ data: null, error: { message: 'connection reset' } })
  assertEquals(await callerHasAction(admin, 'admin', 'manage_staff'), false)
})

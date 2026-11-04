// deno test --allow-env supabase/functions/send-receipt-email/role_gate_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { canEmailReceipt } from './role_gate.ts'

Deno.test('cashier, manager and admin pass', () => {
  for (const r of ['cashier', 'manager', 'admin']) assertEquals(canEmailReceipt(r), true)
})

Deno.test('any other string or null is refused', () => {
  for (const r of ['owner', 'Admin', '', ' admin', null, undefined, 1]) assertEquals(canEmailReceipt(r), false)
})

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared PIN helpers for integration tests and e2e specs (plan 11H). profiles.pin is a salted
 * bcrypt hash, so `.eq('pin', candidate)` never matches: ask the database through
 * staff_ids_with_pin (service role only, active staff only).
 */
export async function staffIdsWithPin(db: SupabaseClient, pin: string): Promise<string[]> {
  const res = (await db.rpc('staff_ids_with_pin', { p_pin: pin })) as { data: string[] | null; error: { message: string } | null };
  if (res.error) throw new Error(`staff_ids_with_pin: ${res.error.message}`);
  return res.data ?? [];
}

/** A six-digit value no active profile currently uses. */
export async function unusedPin(db: SupabaseClient): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = String(100000 + Math.floor(Math.random() * 900000));
    if ((await staffIdsWithPin(db, candidate)).length === 0) return candidate;
  }
  throw new Error('unusedPin: no unused pin found');
}

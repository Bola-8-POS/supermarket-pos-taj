import { z } from 'zod';
import { UserRoleSchema, UuidSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';

const PinMatchSchema = z.object({ id: UuidSchema, name: z.string(), role: UserRoleSchema });

const PinCheckResponseSchema = z.union([
  z.object({ ok: z.literal(true), matches: z.array(PinMatchSchema).min(1), approval_id: UuidSchema.optional() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['INVALID_PIN', 'LOCKED']),
    retry_after: z.number().int().nonnegative(),
  }),
]);

export type PinMatch = z.infer<typeof PinMatchSchema>;

export type PinCheck =
  | { ok: true; matches: PinMatch[]; approvalId?: string }
  | { ok: false; code: 'INVALID_PIN' | 'LOCKED' | 'UNAVAILABLE'; retryAfter: number };

const UNAVAILABLE: PinCheck = { ok: false, code: 'UNAVAILABLE', retryAfter: 0 };

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, i18next/no-literal-string --
   supabase.types.ts lags behind the schema for these RPCs (repo-wide cast pattern); RPC names are not UI copy. */

/**
 * Checks a typed PIN on the server. With `staffId` the PIN must belong to that
 * staff member; without it every active staff member holding the PIN is
 * returned and the caller applies its own role rule. With `requiredAction`,
 * only a match whose role holds that action clears the caller's attempt
 * counter, and the server issues an approval ticket (`approvalId`) for the
 * override RPC to consume. The PIN is never logged.
 */
export async function verifyStaffPin(pin: string, staffId?: string, requiredAction?: string): Promise<PinCheck> {
  try {
    const { data, error } = await (supabase as any).rpc('verify_staff_pin', {
      p_pin: pin,
      p_staff_id: staffId ?? null,
      p_required_action: requiredAction ?? null,
    });
    if (error) {
      logger.warn('staff.pin_check.unavailable', { message: String(error.message) });
      return UNAVAILABLE;
    }
    const parsed = PinCheckResponseSchema.safeParse(data);
    if (!parsed.success) {
      logger.error('staff.pin_check.unexpected_response');
      return UNAVAILABLE;
    }
    return parsed.data.ok
      ? { ok: true, matches: parsed.data.matches, ...(parsed.data.approval_id ? { approvalId: parsed.data.approval_id } : {}) }
      : { ok: false, code: parsed.data.code, retryAfter: parsed.data.retry_after };
  } catch (e) {
    logger.warn('staff.pin_check.unavailable', { message: e instanceof Error ? e.message : 'unknown' });
    return UNAVAILABLE;
  }
}

/** Name of another active staff member already using `pin`, or null (also on error). */
export async function findStaffPinHolder(pin: string, excludeStaffId?: string): Promise<string | null> {
  try {
    const { data, error } = await (supabase as any).rpc('staff_pin_holder', {
      p_pin: pin,
      p_exclude_staff_id: excludeStaffId ?? null,
    });
    return !error && typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, i18next/no-literal-string */

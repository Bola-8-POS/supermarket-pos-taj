import { z } from 'zod';

/** Mirrors license-server/supabase/functions/_shared/license.ts `LicensePayload`. */
export const LicensePlanSchema = z.enum(['monthly', 'yearly', 'lifetime', 'demo']);
export type LicensePlan = z.infer<typeof LicensePlanSchema>;

export const LicensePayloadSchema = z.object({
  v: z.literal(1),
  tenant_id: z.string().min(1),
  tenant_slug: z.string().min(1),
  tenant_name: z.string().min(1),
  terminal_id: z.string().min(1),
  plan: LicensePlanSchema,
  status: z.enum(['active', 'suspended']),
  period_end: z.string().nullable(),
  grace_days: z.number().int().min(0),
  updates_until: z.string().nullable(),
  max_terminals: z.number().int().min(1),
  issued_at: z.string(),
  lease_until: z.string(),
  /** Entitlement allow-list. null/absent = every feature enabled (paid plans). */
  features: z.array(z.string()).nullable().optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export type LicenseLockReason =
  | 'unlicensed' // no token stored yet (fresh install) or token was cleared after a server rejection
  | 'invalid' // stored token failed signature/schema verification
  | 'suspended' // vendor suspended the tenant
  | 'lease_expired' // token not refreshed within lease_days (offline > 2 months by default)
  | 'subscription_expired' // period_end + grace_days passed
  | 'demo_expired'; // plan === 'demo' and period_end passed (grace is 0 for demos)

export type LicenseEvaluation =
  | { state: 'disabled' } // enforcement off (dev / e2e)
  | { state: 'locked'; reason: LicenseLockReason }
  | { state: 'grace'; daysLeft: number } // subscription ended, still inside grace_days
  | { state: 'warning'; kind: 'subscription' | 'lease'; daysLeft: number }
  | { state: 'active' };

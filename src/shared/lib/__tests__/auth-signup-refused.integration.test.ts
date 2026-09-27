/* eslint-disable */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocalTestTarget } from '../test-target-guard';

/**
 * Integration test: the local stack refuses an unauthenticated sign-up and
 * an anonymous sign-in. Run: npx vitest run --project integration
 * src/shared/lib/__tests__/auth-signup-refused.integration.test.ts
 *
 * RED before `supabase/config.toml`'s [auth] enable_signup is applied to
 * the running containers: `npx supabase stop && npx supabase start` picks
 * up the new config (config changes are baked in at container creation,
 * they don't take effect on a running stack).
 *
 * This file's first test creates a real user when signup is still allowed
 * (the RED run) — it never skips, it throws instead if VITE_SUPABASE_URL
 * points anywhere but the local stack, because cleanup here assumes a
 * throwaway local database.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

describe.skipIf(!url || !anonKey)('auth signup refused (local stack)', () => {
  beforeAll(() => {
    assertLocalTestTarget(url);
  });

  let createdUserId: string | null = null;

  afterAll(async () => {
    if (createdUserId && serviceKey) {
      const admin = createClient(url as string, serviceKey, { auth: { persistSession: false } }) as any;
      await admin.auth.admin.deleteUser(createdUserId);
    }
  });

  it('refuses an unauthenticated sign-up', async () => {
    const email = `signup-probe-${String(Date.now())}@example.invalid`;
    const password = randomBytes(8).toString('hex'); // 16 random alphanumerics

    const res = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: anonKey as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body: any = await res.json().catch(() => null);

    if (res.status === 429) {
      throw new Error('rate limited, rerun later');
    }
    if (res.ok) {
      // RED run only: signup is still allowed. Record the created user so
      // afterAll deletes it - a real, unconfirmed local fixture row.
      createdUserId = body?.user?.id ?? body?.id ?? null;
    }

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThanOrEqual(428);

    const errorCode = body?.error_code ?? body?.code;
    const fallbackMatched = typeof body?.msg === 'string' && /signups not allowed/i.test(body.msg);
    expect(errorCode === 'signup_disabled' || fallbackMatched).toBe(true);
  });

  it('refuses an anonymous sign-in (regression guard - already off before and after)', async () => {
    const res = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: anonKey as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json().catch(() => null);

    expect(res.ok).toBe(false);
    const errorCode = body?.error_code ?? body?.code;
    expect(errorCode).toBe('anonymous_provider_disabled');
  });
});

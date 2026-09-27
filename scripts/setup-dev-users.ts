/**
 * setup-dev-users.ts
 *
 * Ensures the four PIN-login E2E staff accounts (admin/manager/cashier/kitchen)
 * exist, matching e2e/helpers/auth.ts's staffForRole(): a `profiles` row plus a
 * linked `auth.users` account whose password equals the profile's `pin` (PINLoginForm
 * calls `supabase.auth.signInWithPassword({ email, password: enteredPin })`).
 * Idempotent — safe to re-run; repairs drift (inactive/deleted/stale password) on
 * accounts that already exist instead of erroring.
 *
 * Usage: cd bar-pos && npx tsx scripts/setup-dev-users.ts
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local, plus
 * E2E_<ROLE>_NAME / E2E_<ROLE>_PIN for each role you want seeded.
 *
 * WARNING: Uses service role key — do NOT import this in the renderer.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ensureStaffAccount } from './lib/ensure-staff-account';

// package.json sets "type": "module", so __dirname isn't defined — derive it
// from import.meta.url instead (same pattern as playwright.config.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local from bar-pos/ directory
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // fallback to .env
}

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local'
  );
  process.exit(1);
}

// Service role client — bypasses RLS, and grants the Admin Auth API used to
// create/update auth.users accounts.
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

// Matches e2e/helpers/auth.ts's StaffRole union. Env prefix stays E2E_BARTENDER
// (internal-only, never user-visible — RESEARCH.md Pitfall 5) even though the
// role value itself is now 'cashier'.
const ROLES: { envPrefix: string; role: 'admin' | 'manager' | 'cashier' | 'kitchen' }[] = [
  { envPrefix: 'E2E_ADMIN', role: 'admin' },
  { envPrefix: 'E2E_MANAGER', role: 'manager' },
  { envPrefix: 'E2E_BARTENDER', role: 'cashier' },
  { envPrefix: 'E2E_KITCHEN', role: 'kitchen' },
];

async function main() {
  console.log('Setting up dev/E2E staff accounts...');

  let anyConfigured = false;
  for (const { envPrefix, role } of ROLES) {
    const name = process.env[`${envPrefix}_NAME`];
    const pin = process.env[`${envPrefix}_PIN`];

    if (!name || !pin) {
      console.warn(`  skipping ${role}: ${envPrefix}_NAME / ${envPrefix}_PIN not set in .env.local`);
      continue;
    }

    anyConfigured = true;
    await ensureStaffAccount(db, role, name, pin);
  }

  if (!anyConfigured) {
    console.error(
      'No E2E_<ROLE>_NAME / E2E_<ROLE>_PIN pairs found in .env.local — nothing to set up.'
    );
    process.exit(1);
  }

  console.log('Dev/E2E staff account setup complete.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

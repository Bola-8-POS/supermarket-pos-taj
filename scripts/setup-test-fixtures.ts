/**
 * setup-test-fixtures.ts
 *
 * Ensures the fixed-UUID integration-test fixture staff accounts exist:
 * Alex Martinez (alex@barpos.dev, cashier) and Jamie Chen (jamie@barpos.dev,
 * manager). ~12 integration/unit test files (queries.clock.test.ts,
 * useCloseTab.test.ts, entities/tab/model/*.integration.test.ts, etc.)
 * hardcode these emails/passwords/UUIDs and call supabase.auth.signInWithPassword
 * directly — unlike the E2E accounts in setup-dev-users.ts, these are not
 * env-configurable, so a `supabase db reset` silently breaks every one of
 * those tests (auth fails, RLS blocks writes, assertions on `.ok`/query data
 * fail) with no obvious link back to "missing seed data". This script closes
 * that gap. Idempotent — safe to re-run.
 *
 * Usage: npx tsx scripts/setup-test-fixtures.ts
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 *
 * WARNING: Uses service role key — do NOT import this in the renderer.
 */

/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY in .env.local'
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) as any;

const FIXTURES: {
  id: string;
  name: string;
  email: string;
  password: string;
  role: 'cashier' | 'manager';
}[] = [
  {
    id: '4d77ef2b-c99d-4dd1-a572-2638ab427496',
    name: 'Alex Martinez',
    email: 'alex@barpos.dev',
    password: '123456',
    role: 'cashier',
  },
  {
    id: 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e',
    name: 'Jamie Chen',
    email: 'jamie@barpos.dev',
    password: '567890',
    role: 'manager',
  },
];

async function ensureFixture(f: (typeof FIXTURES)[number]): Promise<void> {
  const { data: existingUser } = await db.auth.admin.getUserById(f.id);

  if (!existingUser?.user) {
    const { error: createErr } = await db.auth.admin.createUser({
      id: f.id,
      email: f.email,
      password: f.password,
      email_confirm: true,
    });
    if (createErr) {
      console.error(`Failed to create auth user for "${f.name}":`, createErr);
      process.exit(1);
    }
    console.log(`  created auth user: ${f.name} (${f.email})`);
  } else {
    const { error: authUpdateErr } = await db.auth.admin.updateUserById(f.id, {
      password: f.password,
      email_confirm: true,
    });
    if (authUpdateErr) {
      console.error(`Failed to sync auth password for "${f.name}":`, authUpdateErr);
      process.exit(1);
    }
  }

  const { data: existingProfile, error: findErr } = await db
    .from('profiles')
    .select('id')
    .eq('id', f.id)
    .maybeSingle();
  if (findErr) {
    console.error(`Failed to look up profile "${f.name}":`, findErr);
    process.exit(1);
  }

  const profileRow = {
    id: f.id,
    name: f.name,
    email: f.email,
    pin: f.password,
    role: f.role,
    is_active: true,
    deleted_at: null,
    must_change_pin: false,
    locale: 'es-MX',
  };

  if (existingProfile) {
    const { error: updateErr } = await db.from('profiles').update(profileRow).eq('id', f.id);
    if (updateErr) {
      console.error(`Failed to repair profile "${f.name}":`, updateErr);
      process.exit(1);
    }
    console.log(`  ok: ${f.name} (${f.role})`);
  } else {
    const { error: insertErr } = await db.from('profiles').insert(profileRow);
    if (insertErr) {
      console.error(`Failed to insert profile "${f.name}":`, insertErr);
      process.exit(1);
    }
    console.log(`  created profile: ${f.name} (${f.role})`);
  }
}

async function main() {
  console.log('Setting up integration-test fixture staff accounts...');
  for (const f of FIXTURES) {
    await ensureFixture(f);
  }
  console.log('Test fixture account setup complete.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

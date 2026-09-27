import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

export async function setup() {
  // globalSetup runs before Vite loads .env files — load manually
  const dir = dirname(fileURLToPath(import.meta.url)); // bar-pos/src/test
  const barPosRoot = resolve(dir, '../..'); // bar-pos/
  config({ path: resolve(barPosRoot, '.env.local'), override: false });

  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing Supabase credentials.\n' +
        'Ensure VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in bar-pos/.env.local'
    );
  }

  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    console.warn(`[test] Connected to Supabase at ${url}`);
  } catch (e) {
    throw new Error(
      `Cannot reach Supabase at ${url}.\n` +
        `Check VITE_SUPABASE_URL in .env.local\n` +
        `Error: ${String(e)}`
    );
  }
}

export async function teardown() {
  // Cloud Supabase stays running — nothing to tear down
}

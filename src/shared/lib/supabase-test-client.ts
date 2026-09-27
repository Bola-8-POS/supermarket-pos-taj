import { createClient } from '@supabase/supabase-js';
import type { Database } from './supabase.types';

const url: string =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? process.env.VITE_SUPABASE_URL ?? '';
const serviceKey: string =
  (import.meta.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined) ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  '';

/**
 * Service-role Supabase client for test beforeEach/afterEach only.
 * Bypasses RLS — never use in application code.
 */
export const testDb = createClient<Database>(url, serviceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storageKey: 'testdb-service-role-no-conflict',
  },
});

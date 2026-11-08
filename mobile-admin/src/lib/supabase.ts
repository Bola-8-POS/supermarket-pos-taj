import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import type { ServerConfig } from './server-config';

// ponytail: AsyncStorage, not SecureStore — Supabase session JSON exceeds SecureStore's
// 2 KB per-key limit on Android. Upgrade path: LargeSecureStore (AES key in SecureStore,
// ciphertext in AsyncStorage) if a security review asks for it.
function createSupabase(config: ServerConfig) {
  return createClient(config.url, config.anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

// The placeholder keeps imports safe before ServerProvider finishes bootstrapping.
// ES module imports are live bindings, so every query sees replacements made here.
export let SUPABASE_URL = '';
export let supabase = createSupabase({ url: 'http://localhost:54321', anonKey: 'missing-anon-key-for-bootstrap' });

export function configureSupabase(config: ServerConfig): void {
  SUPABASE_URL = config.url;
  supabase = createSupabase(config);
}

// Refresh tokens only while the app is foregrounded (Supabase RN guidance).
AppState.addEventListener('change', state => {
  if (state === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});

// src/shared/lib/backend-url-usage.test.ts
import { describe, expect, it } from 'vitest';

// Every runtime backend address comes from getBackendUrl() / getBackendAnonKey() (or the Supabase client itself).
// The build-time variable may appear only where the fallback lives.
const files = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.*', '!/src/**/*.stories.*', '!/src/test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// connectivity.ts: pre-init probe fallback only (initSupabaseClient -> setProbeTarget supplies the runtime URL);
// it cannot import supabase.ts (supabase.ts imports it: cycle).
const ALLOWED = [/\/src\/shared\/lib\/supabase\.ts$/, /\/src\/shared\/lib\/test-setup\.ts$/, /\/src\/shared\/lib\/connectivity\.ts$/, /\/src\/shared\/lib\/supabase-test-client\.ts$/, /\/src\/vite-env\.d\.ts$/];

describe('build-time backend variables', () => {
  it('are read only where the fallback lives', () => {
    const offenders = Object.entries(files)
      .filter(([file]) => !ALLOWED.some(a => a.test(file)))
      .filter(([, text]) => /\bVITE_SUPABASE_(URL|ANON_KEY)\b/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('scans a believable number of files (the glob matched)', () => {
    expect(Object.keys(files).length).toBeGreaterThan(300);
  });
});

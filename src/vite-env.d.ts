/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** 'cloud' (default) or 'offline-only'. A plain browser (dev server, Playwright) reads it here; the desktop app gets it from the Rust side. */
  readonly VITE_STORE_MODE?: string;
  /** Licensing (see .planning/decisions/2026-09-06-licensing-and-subscription-control.md) */
  readonly VITE_LICENSE_SERVER_URL?: string;
  readonly VITE_LICENSE_SERVER_ANON_KEY?: string;
  readonly VITE_LICENSE_PUBLIC_KEY?: string;
  /** 'true' | 'false'; defaults to enforced in production builds, off in dev/e2e. */
  readonly VITE_LICENSE_ENFORCE?: string;
  /** Online-demo build (see .planning/sdd/2026-09-14-demo-edition-and-online-demo). */
  readonly VITE_DEMO_AUTO_START?: string;
  readonly VITE_DEMO_CONTACT_URL?: string;
  readonly VITE_DEMO_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time by vite.config.ts / vitest.config.ts (scripts/store-expected-schema.ts). */
declare const __STORE_EXPECTED_SCHEMA__: { maxVersion: string; applied: number } | undefined;

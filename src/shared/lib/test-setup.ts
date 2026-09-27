import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, vi } from 'vitest';

// Initialize the real i18next singleton for every unit test (same side-effect
// import as src/main.tsx). shared/ui primitives (ConfirmDialog, DataTable,
// etc.) call useTranslation('common') — without this, t() has no i18next
// instance to attach to and every test using those primitives renders raw
// key strings (e.g. "loading.generic") instead of resolved catalog values.
import { i18nReady } from '@shared/lib/i18n';

// Force en-US regardless of the app's es-MX production default: tests assert
// component behavior via rendered copy (getByText/getByLabelText), and
// pinning to one locale keeps those assertions stable across either
// catalog's future wording changes instead of coupling to translation content.
// Must await init settling first — see the race note in shared/lib/i18n/index.ts.
await i18nReady;
await i18n.changeLanguage('en-US');

// Cleanup after each test. Also reset i18n back to en-US: any test that
// exercises a real login flow (useStaffStore's login()/restoreSession()) calls
// i18n.changeLanguage(staff.locale) as a side effect, and mock staff fixtures
// default to 'es-MX' — without this reset that leaks into every later test in
// the same file (i18next is a module-level singleton, not per-test state).
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en-US');
});

// Mock Tauri IPC in tests (not available in jsdom). isTauri() defaults to
// false — jsdom is never a real Tauri runtime; a test that needs the Tauri
// branch of isTauri()-gated code overrides this mock locally.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: () => false,
}));

// Global Supabase mock — prevents real WebSocket connections that hang forks.
// Tests that need the real DB (queries.clock.test.ts, useCloseTab.test.ts)
// override this with vi.unmock('@shared/lib/supabase') at the top of their file.
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: undefined,
    })),
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signInWithPassword: vi
        .fn()
        .mockResolvedValue({ data: { user: null, session: null }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      stopAutoRefresh: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
  isSupabaseSessionReady: vi.fn(() => true),
  waitForSupabaseSessionReady: vi.fn(() => Promise.resolve()),
  getCachedAccessToken: vi.fn(() => null),
  initSupabaseClient: vi.fn(),
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // deprecated
    removeListener: () => {}, // deprecated
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver (required for ScrollArea component)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView — jsdom has no layout engine and doesn't implement it,
// but cmdk's Command primitive (MultiSelectPicker) calls it on every
// keyboard/selection navigation.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// Mock Tauri updater plugin — not available in jsdom
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}));

// Mock Tauri process plugin — not available in jsdom
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

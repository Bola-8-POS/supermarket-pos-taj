import { defineConfig } from '@playwright/test';
import { findAgentBrowserChrome } from './e2e/helpers/native-instance';

const chromePath = findAgentBrowserChrome();

/**
 * Hermetic store-schema gate suite (two-mode plan 07b): Offline-only mode against a fake store
 * backend that every spec routes with `page.route()`. No Supabase, no sign-in, no .env.local.
 */
const STORE_ENV = {
  VITE_STORE_MODE: 'offline-only',
  VITE_SUPABASE_URL: 'http://localhost:1527/__store',
  VITE_SUPABASE_ANON_KEY: 'e2e-anon',
  VITE_LICENSE_ENFORCE: 'false',
};

export default defineConfig({
  testDir: './e2e/store-schema',
  outputDir: './e2e-results-store-schema',
  testIgnore: [/\.test\.ts$/],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // The first app load through a cold Vite server takes 40-80 s on a loaded host (webServer is never reused), so the stock 30 s/60 s limits fail with goto timeouts.
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-store-schema', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:1527',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 150_000,
    viewport: { width: 1280, height: 800 },
    launchOptions: chromePath ? { executablePath: chromePath } : {},
  },
  projects: [{ name: 'store-schema' }],
  webServer: {
    command: 'npx vite --port 1527 --strictPort',
    url: 'http://localhost:1527',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, ...STORE_ENV },
  },
});

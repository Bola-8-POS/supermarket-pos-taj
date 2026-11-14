import { defineConfig } from '@playwright/test';
import rootConfig from './playwright.config';

/**
 * Plan 11b T11: runs only the store-server page spec (native/app, mocked status and launcher) against dev2 with the
 * root suite's own global setup. The only differences from the root config: the spec is found (root ignores native/),
 * and the dev server is built with VITE_STORE_MODE=offline-only so the page shows its offline-only states.
 */
export default defineConfig({
  ...rootConfig,
  testMatch: /native\/app\/store-server-page\.spec\.ts$/,
  testIgnore: [/\.test\.ts$/],
  workers: 1,
  webServer: {
    ...(rootConfig.webServer as object),
    command: 'npm run dev',
    url: 'http://localhost:1520',
    // a dev server already on 1520 was not started with VITE_STORE_MODE=offline-only
    reuseExistingServer: false,
    env: { ...(process.env as Record<string, string>), VITE_STORE_MODE: 'offline-only' },
  },
});

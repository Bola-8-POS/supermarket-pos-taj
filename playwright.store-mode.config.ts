import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { findAgentBrowserChrome } from './e2e/helpers/native-instance';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env.local') });
const chromePath = findAgentBrowserChrome();

/**
 * Store-mode (offline-only build) specs that still sign in against dev2: the local-store features
 * (backup alert banner) only exist when VITE_STORE_MODE=offline-only; the default build is cloud and
 * never probes /_store/status. Backend URL/keys come from .env.local (dev2, :56321). Own port 1528.
 */
export default defineConfig({
  testDir: './e2e/backup',
  outputDir: './e2e-results-store-mode',
  testIgnore: [/\.test\.ts$/],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: path.join(__dirname, 'e2e', 'global-setup.ts'),
  globalTeardown: path.join(__dirname, 'e2e', 'global-teardown.ts'),
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-store-mode', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:1528',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    viewport: { width: 1280, height: 800 },
    launchOptions: chromePath ? { executablePath: chromePath } : {},
  },
  projects: [{ name: 'store-mode' }],
  webServer: {
    command: 'npx vite --port 1528 --strictPort',
    url: 'http://localhost:1528',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, VITE_STORE_MODE: 'offline-only' } as Record<string, string>,
  },
});

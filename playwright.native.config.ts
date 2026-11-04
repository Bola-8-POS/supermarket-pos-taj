import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rootConfig from './playwright.config';
import { assertNativeStack } from './e2e/helpers/native-stack-guard';
import { chromiumSpkiPins, findAgentBrowserChrome, loadNativeEnv, loadNativeInstance, rootCertPath } from './e2e/helpers/native-instance';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. The ambient environment is checked first (ALLOW_REMOTE_SUPABASE_URL must not be set), then the instance's
//    app.env is layered on top, then the merged result is checked. The webServer env below blanks the
//    non-Supabase VITE_* keys, because Vite itself would otherwise read .env.local for them.
if (process.env['ALLOW_REMOTE_SUPABASE_URL']) {
  throw new Error('refusing native run: ALLOW_REMOTE_SUPABASE_URL is set');
}
const merged = loadNativeEnv();
assertNativeStack(merged); // throws before any dev server or browser starts
for (const [k, v] of Object.entries(merged)) {
  if (typeof v === 'string') process.env[k] = v;
}
const inst = loadNativeInstance();

const chromePath = findAgentBrowserChrome();
const pins = inst.scheme === 'https' ? chromiumSpkiPins(inst.dataRoot) : [];
// The store root's and intermediate's public-key hashes (Caddy sends leaf + intermediate): Chromium accepts a chain that
// contains one of them, without touching the OS store.
const chromeArgs = pins.length > 0 ? [`--ignore-certificate-errors-spki-list=${pins.join(',')}`] : [];
// --project=x and --project x (and -p)
const selectedProjects = process.argv.flatMap((a, i) => (a.startsWith('--project=') ? [a.slice('--project='.length)] : a === '--project' || a === '-p' ? [process.argv[i + 1] ?? ''] : []));
const wantsApp = !(selectedProjects.length === 1 && selectedProjects[0] === 'gateway');
// The full-suite project runs the whole root suite (same testDir and ignore list) against the native instance. Its Node-side
// clients (role-scoped sign-ins, direct function calls) talk to the LAN address, so on a TLS instance they trust the store's
// own root through NODE_EXTRA_CA_CERTS (read by every Playwright worker at start; never NODE_TLS_REJECT_UNAUTHORIZED).
const fullSuite = selectedProjects.includes('full-suite');
if (fullSuite) process.env['POS_NATIVE_FULL_SUITE'] = '1';
if (fullSuite && inst.scheme === 'https') process.env['NODE_EXTRA_CA_CERTS'] = rootCertPath(inst.dataRoot);
const fastE2e = process.env['FAST_E2E'] === '1' || process.env['FAST_E2E'] === 'true';
const slowMo = fastE2e ? 0 : 400;

export default defineConfig({
  testDir: './e2e/native',
  outputDir: './e2e-results-native',
  testIgnore: [/\.test\.ts$/],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  globalSetup: path.join(__dirname, 'e2e', 'native', 'global-setup.ts'),
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-native', open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', headless: true, viewport: { width: 1280, height: 800 } },
  projects: [
    { name: 'gateway', testMatch: /gateway\/.*\.spec\.ts/ },
    {
      name: 'app',
      testMatch: /app\/.*\.spec\.ts/,
      // Vite's dev server transforms ~2000 modules per cold page load (about 45 s on this machine), and the boot spec waits
      // out a 30 s poll interval on top.
      timeout: 300_000,
      use: {
        baseURL: 'http://localhost:1526',
        launchOptions: { ...(chromePath ? { executablePath: chromePath } : {}), args: chromeArgs },
      },
    },
    {
      name: 'full-suite',
      testDir: './e2e',
      // the root suite's own ignore list (visual, license, remote-smoke, training, tutorials, native, helper unit tests)
      // POS_NATIVE_EXCLUDE (a regex source, e.g. "soak/") drops further folders, for a run that leaves out the long soak test
      testIgnore: [...[rootConfig.testIgnore ?? []].flat(), ...(process.env['POS_NATIVE_EXCLUDE'] ? [new RegExp(process.env['POS_NATIVE_EXCLUDE'])] : [])],
      timeout: fastE2e ? 45_000 : 60_000,
      expect: { timeout: fastE2e ? 5_000 : 10_000 },
      use: {
        baseURL: 'http://localhost:1526',
        // POS_NATIVE_TZ (an IANA name) forces the browser's time zone, e.g. to make the local date differ from the UTC date
        ...(process.env['POS_NATIVE_TZ'] ? { timezoneId: process.env['POS_NATIVE_TZ'] } : {}),
        actionTimeout: fastE2e ? 10_000 : 15_000,
        navigationTimeout: fastE2e ? 15_000 : 30_000,
        launchOptions: { ...(chromePath ? { executablePath: chromePath } : {}), args: chromeArgs, slowMo },
      },
    },
  ],
  webServer: wantsApp
    ? {
        command: 'npx vite --port 1526 --strictPort',
        url: 'http://localhost:1526',
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          ...(process.env as Record<string, string>),
          // Vite loads .env.local from the project root for every key process.env does not set: blank the ones that
          // would make the native app talk to a license server, a demo project or a model host.
          VITE_LICENSE_SERVER_URL: '',
          VITE_LICENSE_SERVER_ANON_KEY: '',
          VITE_LICENSE_ENFORCE: '',
          VITE_DEMO_AUTO_START: '',
          VITE_OLLAMA_URL: '',
          VITE_AGENT_ENABLED: '',
          // the service-role key is for Node-side helpers only, never the browser build's process
          SUPABASE_SERVICE_ROLE_KEY: '',
          VITE_SUPABASE_URL: inst.appUrl,
          VITE_SUPABASE_ANON_KEY: inst.anonKey,
          VITE_STORE_MODE: 'offline-only',
        },
      }
    : undefined,
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig(async () => {
  // Storybook + browser testing pulls in Playwright and can hang startup on some Windows setups.
  // Make it opt-in (set RUN_STORYBOOK_TESTS=1) or run without forcing `--project unit`.
  const argv = process.argv.join(' ');
  const runStorybook =
    process.env.RUN_STORYBOOK_TESTS === '1' &&
    !argv.includes('--project unit') &&
    !argv.includes('--project=unit');

  const storybookProjects = runStorybook
    ? [
        {
          extends: true,
          plugins: [
            (
              await import('@storybook/addon-vitest/vitest-plugin')
            ).storybookTest({
              configDir: path.join(dirname, '.storybook'),
            }),
          ],
          test: {
            name: 'storybook',
            browser: {
              enabled: true,
              headless: true,
              provider: (await import('@vitest/browser-playwright')).playwright({}),
              instances: [{ browser: 'chromium' }],
            },
          },
        },
      ]
    : [];

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@app': path.resolve(__dirname, './src/app'),
        '@pages': path.resolve(__dirname, './src/pages'),
        '@widgets': path.resolve(__dirname, './src/widgets'),
        '@features': path.resolve(__dirname, './src/features'),
        '@entities': path.resolve(__dirname, './src/entities'),
        '@shared': path.resolve(__dirname, './src/shared'),
      },
    },
    test: {
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['src/**/*.stories.tsx', 'src/**/*.test.*', 'src/shared/lib/supabase.types.ts', 'src/**/*.d.ts'],
      },
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            globals: true,
            environment: 'jsdom',
            setupFiles: ['./src/shared/lib/test-setup.ts'],
            include: ['src/**/*.{test,spec}.{ts,tsx}'],
            // Real-Supabase integration tests: run explicitly with
            // `npx vitest run src/path/to/foo.integration.test.ts` or a dedicated job.
            exclude: [
              'e2e/**',
              'node_modules/**',
              '**/*.integration.test.ts',
            ],
            testTimeout: 20000,
            hookTimeout: 20000,
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            globalSetup: './src/test/global-setup.ts',
            globals: true,
            // jsdom (not 'node') — several *.integration.test.ts files use
            // @testing-library/react's renderHook against real Supabase RPCs
            // and need `document`; jsdom doesn't block the real network calls.
            environment: 'jsdom',
            // Real-Supabase integration tests only. Not part of `npm run test`
            // (unit project excludes these) — run explicitly via `npm run
            // test:integration` or `npx vitest run <path>.integration.test.ts`.
            include: ['src/**/*.integration.test.ts'],
            exclude: ['e2e/**', 'node_modules/**'],
            testTimeout: 30000,
            hookTimeout: 30000,
            // Integration files share ad hoc fixtures (e.g. "find-or-create the
            // one open caja session") against ONE live local Supabase instance.
            // Running files concurrently races those fixtures against each
            // other; caja-per-terminal (which permits >1 open session at once)
            // surfaced this as intermittent NO_OPEN_CAJA failures. Serial file
            // execution is the correct default for tests hitting shared
            // external state, not a workaround.
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'e2e-tools',
            environment: 'node',
            globals: true,
            include: ['e2e/tutorials/**/*.test.ts', 'scripts/tutorial-videos-convert.test.ts', 'scripts/**/*.test.mjs'],
            testTimeout: 10_000,
          },
        },
        ...storybookProjects,
      ],
    },
  };
});
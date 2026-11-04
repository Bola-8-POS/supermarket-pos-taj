import { afterEach, describe, expect, it, vi } from 'vitest';

describe('APP_VERSION', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses VITE_APP_VERSION when set', async () => {
    vi.stubEnv('VITE_APP_VERSION', '9.8.7');
    const { APP_VERSION } = await import('./app-version');
    expect(APP_VERSION).toBe('9.8.7');
  });

  it('falls back to 0.0.0 when unset or empty', async () => {
    vi.stubEnv('VITE_APP_VERSION', '');
    const { APP_VERSION } = await import('./app-version');
    expect(APP_VERSION).toBe('0.0.0');
  });
});

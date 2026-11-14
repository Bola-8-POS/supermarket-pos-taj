import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LoggerModule from '@shared/lib/logger';
import type * as SupabaseModule from '@shared/lib/supabase';

const warn = vi.fn();
vi.mock('@shared/lib/logger', async (importOriginal) => ({ ...(await importOriginal<typeof LoggerModule>()), logger: { warn: (...a: unknown[]) => warn(...a) } }));
vi.mock('@shared/lib/supabase', async () => {
  const actual = await vi.importActual<typeof SupabaseModule>('@shared/lib/supabase');
  return {
    ...actual,
    getBackendUrl: () => {
      throw new actual.StoreConfigInvalidError('https://secret-host:1/ key-abc');
    },
    getBackendAnonKey: () => 'k',
  };
});

import { currentEndpoint } from './queries';

describe('currentEndpoint', () => {
  beforeEach(() => warn.mockClear());

  it('returns null when the store config is unusable and warns once, with the code only', () => {
    expect(currentEndpoint()).toBeNull();
    expect(currentEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('store_status.endpoint_unusable', { code: 'STORE_CONFIG_INVALID' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-host|key-abc/);
  });
});

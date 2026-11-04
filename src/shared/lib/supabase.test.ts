import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from './license/store';
import type { LicenseEvaluation } from './license/types';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from './store-mode';
import { licenseGuardedFetch } from './supabase';

// test-setup.ts mocks the client module globally; this file tests the real guard.
vi.unmock('@shared/lib/supabase');

let evaluation: LicenseEvaluation = { state: 'active' };
vi.mock('./license/store', async importOriginal => ({
  ...(await importOriginal<typeof StoreModule>()),
  currentLicenseEvaluation: () => evaluation,
}));

const guardWriteMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('./store-schema/guard', () => ({ guardWrite: guardWriteMock }));

const BASE = 'http://127.0.0.1:56321';
const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));

const call = (path: string, method = 'POST') => licenseGuardedFetch(`${BASE}${path}`, { method });

describe('licenseGuardedFetch', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    guardWriteMock.mockReset();
    guardWriteMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetStoreRuntimeConfigForTests();
  });

  describe('restricted (licensed store offline too long)', () => {
    beforeEach(() => {
      evaluation = { state: 'restricted', reason: 'lease_expired' };
    });

    it.each([
      '/auth/v1/token?grant_type=refresh_token',
      '/functions/v1/staff-sign-in',
      '/functions/v1/change-own-pin',
      '/functions/v1/get-server-time',
      '/rest/v1/rpc/close_caja_session',
      '/rest/v1/rpc/register_caja_entry',
      '/rest/v1/rpc/get_caja_report',
      '/rest/v1/rpc/verify_staff_pin',
      '/rest/v1/rpc/staff_pin_holder',
      '/rest/v1/rpc/record_audit',
      '/rest/v1/shifts?select=*',
    ])('permits %s so the shift can be closed out', async path => {
      await call(path);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('the restricted licence lets resolve_offline_sale through', async () => {
      await call('/rest/v1/rpc/resolve_offline_sale');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('permits clocking out (PATCH on shifts)', async () => {
      await call('/rest/v1/shifts?id=eq.1&staff_id=eq.2', 'PATCH');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      '/rest/v1/rpc/process_direct_sale_atomic',
      '/functions/v1/process-direct-sale',
      '/functions/v1/process-payment',
      '/functions/v1/receive-shipment',
      '/rest/v1/rpc/process_refund',
      '/rest/v1/rpc/caja_open',
      '/rest/v1/products',
    ])('refuses %s', async path => {
      await expect(call(path)).rejects.toThrow(/LICENSE_RESTRICTED/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a sale whose query string merely mentions an allowed path', async () => {
      await expect(
        call('/rest/v1/rpc/process_direct_sale_atomic?x=/rest/v1/rpc/close_caja_session')
      ).rejects.toThrow(/LICENSE_RESTRICTED/);
    });

    it('still lets reads through', async () => {
      await call('/rest/v1/products?select=*', 'GET');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('restricted without scope still refuses process-direct-sale', async () => {
      await expect(call('/functions/v1/process-direct-sale')).rejects.toThrow(/LICENSE_RESTRICTED/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('for an offline sale replay request', () => {
      const replay = (path: string) =>
        licenseGuardedFetch(`${BASE}${path}`, { method: 'POST' }, { offlineReplay: true });

      it('lets exactly process-direct-sale through', async () => {
        await replay('/functions/v1/process-direct-sale');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it.each([
        '/functions/v1/process-payment',
        '/functions/v1/process-direct-sale-extra',
        '/functions/v1/process-direct-sale/nested',
        '/rest/v1/rpc/process_direct_sale_atomic',
        '/rest/v1/products',
        '/functions/v1/process-direct-sale-x?y=/functions/v1/process-direct-sale',
        '/other/functions/v1/process-direct-sale',
      ])('still refuses %s', async path => {
        await expect(replay(path)).rejects.toThrow(/LICENSE_RESTRICTED/);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('a concurrent ordinary sale is refused while a replay request is in flight', async () => {
        let release: (r: Response) => void = () => undefined;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => (release = resolve)));
        const inFlight = replay('/functions/v1/process-direct-sale');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await expect(call('/functions/v1/process-direct-sale')).rejects.toThrow(/LICENSE_RESTRICTED/);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        release(new Response('{}'));
        await inFlight;
        await expect(call('/functions/v1/process-direct-sale')).rejects.toThrow(/LICENSE_RESTRICTED/);
      });

      it('only an explicit true counts', async () => {
        await expect(
          licenseGuardedFetch(`${BASE}/functions/v1/process-direct-sale`, { method: 'POST' }, {})
        ).rejects.toThrow(/LICENSE_RESTRICTED/);
      });
    });
  });

  describe('locked (never licensed, invalid, suspended)', () => {
    beforeEach(() => {
      evaluation = { state: 'locked', reason: 'unlicensed' };
    });

    it('refuses every write, including closing the caja', async () => {
      await expect(call('/rest/v1/rpc/close_caja_session')).rejects.toThrow(/LICENSE_LOCKED/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still lets auth through', async () => {
      await call('/auth/v1/token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses process-direct-sale even for an offline sale replay request', async () => {
      await expect(
        licenseGuardedFetch(
          `${BASE}/functions/v1/process-direct-sale`,
          { method: 'POST' },
          { offlineReplay: true }
        )
      ).rejects.toThrow(/LICENSE_LOCKED/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('an active licence is not filtered at all', async () => {
    evaluation = { state: 'active' };
    await call('/functions/v1/process-direct-sale');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('store schema gate (Offline-only)', () => {
    beforeEach(() => {
      evaluation = { state: 'active' };
      setStoreRuntimeConfig({ storeMode: 'offline-only' });
    });

    it('blocking_gate_rejects_a_post_and_sends_nothing', async () => {
      guardWriteMock.mockRejectedValue(new Error('STORE_SCHEMA_MISMATCH: server-outdated'));
      await expect(call('/rest/v1/rpc/anything')).rejects.toThrow(/STORE_SCHEMA_MISMATCH/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('offlineReplay_true_is_still_held_by_schema_gate', async () => {
      guardWriteMock.mockRejectedValue(new Error('STORE_SCHEMA_MISMATCH: client-outdated'));
      await expect(
        licenseGuardedFetch(`${BASE}/functions/v1/process-direct-sale`, { method: 'POST' }, { offlineReplay: true })
      ).rejects.toThrow(/STORE_SCHEMA_MISMATCH/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('get_and_auth_paths_are_never_gated', async () => {
      guardWriteMock.mockRejectedValue(new Error('STORE_SCHEMA_MISMATCH: missing'));
      await call('/rest/v1/products', 'GET');
      await call('/rest/v1/products', 'HEAD');
      await call('/auth/v1/token');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(guardWriteMock).not.toHaveBeenCalled();
    });

    it('guard_applies_once_the_mode_is_set_without_a_client_init', async () => {
      // The mode alone arms the guard. The set-before-init ORDER is pinned in AppConfigProvider.test.tsx.
      await call('/rest/v1/rpc/anything');
      expect(guardWriteMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('cloud_mode_never_calls_guard', async () => {
    evaluation = { state: 'active' };
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    await call('/rest/v1/rpc/anything');
    expect(guardWriteMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

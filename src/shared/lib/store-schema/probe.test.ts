import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProbeTarget } from '../connectivity';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '../store-mode';
import { getExpectedSchema } from './expected';
import { probeStoreSchema } from './probe';

const B = getExpectedSchema();
const rows = (max: string, applied: number) => JSON.stringify([{ max_version: max, applied }]);
const res = (status: number, body: string) => new Response(body, { status });

describe('probeStoreSchema', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setProbeTarget('http://store.test', 'anon-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetStoreRuntimeConfigForTests();
  });

  it.each([
    ['200 equal', () => res(200, rows(B.maxVersion, B.applied)), 'ok'],
    ['200 older server', () => res(200, rows('20200101000001', 1)), 'server-outdated'],
    ['200 newer server', () => res(200, rows('99999999999999', B.applied + 5)), 'client-outdated'],
    ['200 one field off', () => res(200, rows(B.maxVersion, B.applied - 1)), 'inconsistent'],
    ['200 empty body', () => res(200, '[]'), 'missing'],
    ['200 non-JSON body', () => res(200, 'not json'), 'missing'],
    ['200 wrong field types', () => res(200, JSON.stringify([{ max_version: 20261018000004, applied: '266' }])), 'missing'],
    ['200 two rows', () => res(200, JSON.stringify([{ max_version: B.maxVersion, applied: B.applied }, { max_version: B.maxVersion, applied: B.applied }])), 'missing'],
    ['200 max_version not 14 digits', () => res(200, rows('2026', B.applied)), 'missing'],
    ['200 applied negative', () => res(200, JSON.stringify([{ max_version: B.maxVersion, applied: -1 }])), 'missing'],
    ['200 applied fractional', () => res(200, JSON.stringify([{ max_version: B.maxVersion, applied: 1.5 }])), 'missing'],
    ['404', () => res(404, '{}'), 'missing'],
    ['503 STORE_UPDATING', () => res(503, '{"code":"STORE_UPDATING"}'), 'updating'],
    ['400', () => res(400, '{}'), 'missing'],
    ['401', () => res(401, '{}'), 'unreachable'],
    ['500', () => res(500, '{}'), 'unreachable'],
    ['503 other', () => res(503, '{"code":"X"}'), 'unreachable'],
  ])('maps_every_row_of_the_verdict_table: %s', async (_n, make, kind) => {
    fetchMock.mockResolvedValue(make());
    expect((await probeStoreSchema()).kind).toBe(kind);
  });

  it('maps_every_row_of_the_verdict_table: transport failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect((await probeStoreSchema()).kind).toBe('unreachable');
  });

  it('times_out_after_4s_as_unreachable', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const p = probeStoreSchema();
    await vi.advanceTimersByTimeAsync(4000);
    expect((await p).kind).toBe('unreachable');
  });

  it('uses_get_with_apikey_and_never_the_license_server', async () => {
    fetchMock.mockResolvedValue(res(200, rows(B.maxVersion, B.applied)));
    await probeStoreSchema();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://store.test/rest/v1/store_schema_version?select=max_version,applied');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['apikey']).toBe('anon-key');
  });

  it('refused_store_env_never_probes', async () => {
    setStoreRuntimeConfig({ storeMode: 'offline-only', storeConfigError: 'STORE_ENV_INVALID' });
    expect((await probeStoreSchema()).kind).toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

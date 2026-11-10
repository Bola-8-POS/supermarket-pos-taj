import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProbeTarget } from '../connectivity';
import { appVersionOf, compareSemver, fetchServerPackVersion, serverReadyForAppVersion } from './server-pack';

const fetchMock = vi.fn();
const health = (pack: string) => new Response(JSON.stringify({ packVersion: pack }), { status: 200 });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setProbeTarget('http://store.test', 'k');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('version helpers', () => {
  it('appVersionOf_strips_the_revision', () => {
    expect(appVersionOf('1.11.0-r1')).toBe('1.11.0');
    expect(appVersionOf('12.0.3-r27')).toBe('12.0.3');
  });
  it('appVersionOf_rejects_other_shapes', () => {
    for (const v of ['1.11.0', '1.11-r1', 'v1.11.0-r1', '', 'x.y.z-r1']) expect(appVersionOf(v)).toBeNull();
  });
  it('compareSemver_orders_and_returns_null_on_garbage', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('1.2', '1.2.3')).toBeNull();
    expect(compareSemver('1.2.3-beta', '1.2.3')).toBeNull();
  });
});

describe('fetchServerPackVersion', () => {
  it('fetch_returns_null_when_fenced_or_malformed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":"STORE_UPDATING"}', { status: 503 }));
    expect(await fetchServerPackVersion()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(await fetchServerPackVersion()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('{"packVersion":5}', { status: 200 }));
    expect(await fetchServerPackVersion()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ packVersion: 'x'.repeat(65) }), { status: 200 }));
    expect(await fetchServerPackVersion()).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await fetchServerPackVersion()).toBeNull();
  });

  it('reads_packVersion_with_a_keyless_get', async () => {
    fetchMock.mockResolvedValue(health('1.11.0-r1'));
    expect(await fetchServerPackVersion()).toBe('1.11.0-r1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://store.test/_store/health');
    expect(init.headers).toBeUndefined();
  });
});

describe('serverReadyForAppVersion', () => {
  it('ready_when_server_is_at_or_above', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(health('1.11.0-r2')));
    expect(await serverReadyForAppVersion('1.11.0')).toBe('ready');
    expect(await serverReadyForAppVersion('1.10.9')).toBe('ready');
  });
  it('wait_when_server_is_behind', async () => {
    fetchMock.mockResolvedValue(health('1.10.0-r1'));
    expect(await serverReadyForAppVersion('1.11.0')).toBe('wait-server');
  });
  it('wait_when_server_is_fenced', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    expect(await serverReadyForAppVersion('1.11.0')).toBe('wait-server');
  });
  it('unparseable_is_reported', async () => {
    fetchMock.mockResolvedValue(health('weird'));
    expect(await serverReadyForAppVersion('1.11.0')).toBe('unparseable');
    fetchMock.mockResolvedValue(health('1.11.0-r1'));
    expect(await serverReadyForAppVersion('1.11')).toBe('unparseable');
  });
});

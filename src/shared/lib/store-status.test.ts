import { afterEach, describe, expect, it, vi } from 'vitest';
import catalog from './store-alert-catalog.json';
import {
  fetchStoreStatus,
  isStoreServerUrl,
  pickBackupAlert,
  StoreStatusSchema,
  storeStatusUrl,
} from './store-status';
import golden from './store-status.golden.json';

const base = { schema: 1 as const, generatedAt: '2026-10-03T10:00:00Z' };
const parse = (o: unknown) => StoreStatusSchema.parse({ ...base, ...(o as object) });

describe('isStoreServerUrl', () => {
  it('treats hosted Supabase as not a store server and everything else as one', () => {
    expect(isStoreServerUrl('https://example-project.supabase.co')).toBe(false);
    expect(isStoreServerUrl('https://abc.supabase.in')).toBe(false);
    expect(isStoreServerUrl('https://x.supabase.co.')).toBe(false);
    expect(isStoreServerUrl('https://store-pc:47304')).toBe(true);
    expect(isStoreServerUrl('https://192.168.1.20:47304')).toBe(true);
    expect(isStoreServerUrl('http://127.0.0.1:56321')).toBe(true);
    expect(isStoreServerUrl('not a url')).toBe(false);
  });
});

describe('storeStatusUrl', () => {
  it('appends the path once', () => {
    expect(storeStatusUrl('https://store-pc:47304')).toBe('https://store-pc:47304/_store/status');
    expect(storeStatusUrl('https://store-pc:47304///')).toBe(
      'https://store-pc:47304/_store/status'
    );
  });
});

describe('pickBackupAlert', () => {
  it('returns null when there is no backup alert, even if other alerts exist', () => {
    expect(
      pickBackupAlert(parse({ alerts: [{ code: 'DISK_LOW', level: 'warn', since: 'x' }] }))
    ).toBeNull();
    expect(pickBackupAlert(parse({}))).toBeNull();
  });

  it('shows the worst alert first: the 72 h gap, then a failed drill, then a missing drive, then the rest', () => {
    const alerts = [
      'BACKUP_VERIFY_OVERDUE',
      'BACKUP_KEY_NOT_EXPORTED',
      'BACKUP_STALE_24H',
      'BACKUP_DEST_DOWN',
      'BACKUP_VERIFY_FAILED',
      'BACKUP_STALE_72H',
    ].map(code => ({
      code,
      level: code === 'BACKUP_STALE_72H' || code === 'BACKUP_VERIFY_FAILED' ? 'critical' : 'warn',
      since: '2026-10-01T00:00:00Z',
    }));
    const order: string[] = [];
    let rest = alerts;
    while (rest.length) {
      const p = pickBackupAlert(parse({ alerts: rest }));
      order.push(p!.code);
      rest = rest.filter(a => a.code !== p!.code);
    }
    expect(order).toEqual([
      'BACKUP_STALE_72H',
      'BACKUP_VERIFY_FAILED',
      'BACKUP_DEST_DOWN',
      'BACKUP_STALE_24H',
      'BACKUP_KEY_NOT_EXPORTED',
      'BACKUP_VERIFY_OVERDUE',
    ]);
  });

  it('names the drives that are down, never the local copy', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [{ code: 'BACKUP_DEST_DOWN', level: 'warn', since: 'x' }],
        backup: {
          alert: 'warn',
          destinations: [
            { name: 'local', ok: false },
            { name: 'usb-e', ok: false },
            { name: 'r2', ok: true },
          ],
        },
      })
    );
    expect(p).toEqual({ code: 'BACKUP_DEST_DOWN', level: 'warn', names: ['usb-e'] });
  });

  it('prefers the alert own dests over the destinations list', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [{ code: 'BACKUP_DEST_DOWN', level: 'warn', since: 'x', dests: ['usb-f'] }],
        backup: { alert: 'warn', destinations: [{ name: 'usb-e', ok: false }] },
      })
    );
    expect(p?.names).toEqual(['usb-f']);
  });

  it('reads the level from the alert', () => {
    expect(
      pickBackupAlert(
        parse({ alerts: [{ code: 'BACKUP_STALE_72H', level: 'critical', since: 'x' }] })
      )?.level
    ).toBe('critical');
  });

  it('shows a critical pick for an unlisted code such as BACKUP_STATE_UNKNOWN', () => {
    const p = pickBackupAlert(
      parse({ alerts: [{ code: 'BACKUP_STATE_UNKNOWN', level: 'critical', since: 'x' }] })
    );
    expect(p).toEqual({ code: 'BACKUP_STATE_UNKNOWN', level: 'critical', names: [] });
  });

  it('shows a warn pick for an unlisted code at warn', () => {
    const p = pickBackupAlert(
      parse({ alerts: [{ code: 'BACKUP_RESTORE_WARNING', level: 'warn', since: 'x' }] })
    );
    expect(p).toEqual({ code: 'BACKUP_RESTORE_WARNING', level: 'warn', names: [] });
  });

  it('ignores codes that are not backup codes', () => {
    expect(
      pickBackupAlert(parse({ alerts: [{ code: 'DISK_LOW', level: 'critical', since: 'x' }] }))
    ).toBeNull();
  });

  it('a critical unlisted code outranks a known warn code; at equal level the known code wins', () => {
    const mixed = pickBackupAlert(
      parse({
        alerts: [
          { code: 'BACKUP_STALE_24H', level: 'warn', since: 'x' },
          { code: 'BACKUP_PHOTOS_UNREADABLE', level: 'critical', since: 'x' },
        ],
      })
    );
    expect(mixed?.code).toBe('BACKUP_PHOTOS_UNREADABLE');
    expect(mixed?.level).toBe('critical');
    const equal = pickBackupAlert(
      parse({
        alerts: [
          { code: 'BACKUP_RESTORE_WARNING', level: 'warn', since: 'x' },
          { code: 'BACKUP_VERIFY_OVERDUE', level: 'warn', since: 'x' },
        ],
      })
    );
    expect(equal?.code).toBe('BACKUP_VERIFY_OVERDUE');
  });

  it('keeps the server reason on the pick', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [{ code: 'BACKUP_STALE_24H', level: 'warn', since: 'x', reason: 'no-destination' }],
      })
    );
    expect(p?.reason).toBe('no-destination');
  });

  it('is not hidden by one alert, from any plan, whose since is null or missing', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [
          { code: 'DISK_LOW', level: 'warn', since: null },
          { code: 'SOMETHING_ELSE', level: 'warn' },
          { code: 'BACKUP_STALE_72H', level: 'critical', since: null },
        ],
      })
    );
    expect(p?.code).toBe('BACKUP_STALE_72H');
  });

  it('skips a malformed alert on its own and still shows the valid backup alert', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [
          'junk',
          { code: 5, level: null },
          { level: 'warn' },
          { code: 'BACKUP_STALE_24H', level: 'warn', since: 'x' },
        ],
      })
    );
    expect(p?.code).toBe('BACKUP_STALE_24H');
  });

  it('names the single dest an alert carries when it has no dests list', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [{ code: 'BACKUP_DEST_FAILING', level: 'warn', since: 'x', dest: 'usb-f' }],
        backup: {
          alert: 'warn',
          destinations: [
            { name: 'usb-e', ok: false },
            { name: 'usb-f', ok: false },
          ],
        },
      })
    );
    expect(p?.names).toEqual(['usb-f']);
  });

  it('prefers dests over dest, and dest over the destinations filter', () => {
    const both = pickBackupAlert(
      parse({
        alerts: [
          {
            code: 'BACKUP_DEST_DOWN',
            level: 'warn',
            since: 'x',
            dest: 'usb-g',
            dests: ['usb-f', 'usb-g'],
          },
        ],
      })
    );
    expect(both?.names).toEqual(['usb-f', 'usb-g']);
  });

  it('reads the level case-insensitively', () => {
    expect(
      pickBackupAlert(
        parse({ alerts: [{ code: 'BACKUP_STALE_72H', level: 'CRITICAL', since: 'x' }] })
      )?.level
    ).toBe('critical');
    expect(
      pickBackupAlert(parse({ alerts: [{ code: 'BACKUP_STALE_24H', level: 'Warn', since: 'x' }] }))
        ?.level
    ).toBe('warn');
  });

  it('the level is the worst of the chosen alert and backup.alert', () => {
    const p = pickBackupAlert(
      parse({
        alerts: [{ code: 'BACKUP_STALE_24H', level: 'warn', since: 'x' }],
        backup: { alert: 'critical', destinations: [] },
      })
    );
    expect(p?.level).toBe('critical');
  });
});

describe('StoreStatusSchema', () => {
  it('refuses a body that is not the store status', () => {
    expect(StoreStatusSchema.safeParse({ schema: 2 }).success).toBe(false);
    expect(StoreStatusSchema.safeParse('<html>').success).toBe(false);
  });
});

describe('fetchStoreStatus', () => {
  const endpoint = { url: 'https://store-pc:47304/', anonKey: 'anon-key-under-test' };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks /_store/status with the exact key in the apikey header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ schema: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchStoreStatus(endpoint);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://store-pc:47304/_store/status');
    expect((init.headers as Record<string, string>)['apikey']).toBe('anon-key-under-test');
  });

  it('gives an error for a non-200 answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    expect((await fetchStoreStatus(endpoint)).ok).toBe(false);
  });

  it('gives VALIDATION_ERROR, not NETWORK_OFFLINE, for a body that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    const r = await fetchStoreStatus(endpoint);
    expect(r.ok ? null : r.error.code).toBe('VALIDATION_ERROR');
  });

  it('gives NETWORK_OFFLINE when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    const r = await fetchStoreStatus(endpoint);
    expect(r.ok ? null : r.error.code).toBe('NETWORK_OFFLINE');
  });

  it('passes a signal that aborts with the caller and gives up after 10 s', async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_u: string, init: RequestInit) => {
        const s = init.signal as AbortSignal;
        seen.push(s);
        return new Promise<Response>((_res, rej) => {
          s.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        });
      })
    );
    const caller = new AbortController();
    const first = fetchStoreStatus(endpoint, caller.signal);
    caller.abort();
    expect((await first).ok).toBe(false);
    expect(seen[0]?.aborted).toBe(true);
    const second = fetchStoreStatus(endpoint);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await second).ok).toBe(false);
    expect(seen[1]?.aborted).toBe(true);
  });

  it('gives NETWORK_OFFLINE, not VALIDATION_ERROR, when the request is aborted while the body is being read', async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => {
          caller.abort();
          return Promise.reject(new DOMException('aborted', 'AbortError'));
        },
      })
    );
    const r = await fetchStoreStatus(endpoint, caller.signal);
    expect(r.ok ? null : r.error.code).toBe('NETWORK_OFFLINE');
  });

  it('leaves no timer running after a successful fetch', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema: 1 }), { status: 200 }))
    );
    expect((await fetchStoreStatus(endpoint)).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchStoreStatus server clock', () => {
  it('returns the response Date header as serverDate', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ schema: 1, generatedAt: 'x' }), {
            status: 200,
            headers: { Date: 'Wed, 04 Nov 2026 10:02:00 GMT' },
          })
        )
    );
    const r = await fetchStoreStatus({ url: 'https://store-pc:47304', anonKey: 'k' });
    vi.unstubAllGlobals();
    expect(r.ok && r.data.serverDate).toBe('Wed, 04 Nov 2026 10:02:00 GMT');
  });
});

describe('status.json written by store-server (golden fixture)', () => {
  it('parses, and every alert code is in the app catalog', () => {
    const parsed = StoreStatusSchema.parse(golden);
    expect(parsed.alerts.length).toBeGreaterThan(0);
    for (const a of parsed.alerts) expect(Object.keys(catalog)).toContain(a.code);
  });
});

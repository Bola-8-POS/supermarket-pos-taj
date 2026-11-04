/* eslint-disable import/order -- vi.mock factories must precede imports */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idb = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  fail: false,
}));
vi.mock('idb-keyval', () => ({
  get: vi.fn((k: string) =>
    idb.fail ? Promise.reject(new Error('IDB blocked')) : Promise.resolve(idb.store.get(k))
  ),
  set: vi.fn((k: string, v: unknown) => {
    if (idb.fail) return Promise.reject(new Error('IDB blocked'));
    idb.store.set(k, v);
    return Promise.resolve();
  }),
  del: vi.fn((k: string) => {
    if (idb.fail) return Promise.reject(new Error('IDB blocked'));
    idb.store.delete(k);
    return Promise.resolve();
  }),
}));

import { QueryClient, dehydrate, onlineManager, useQuery } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { inventoryKeys, NEAR_EXPIRY_PRICING_LOOKAHEAD_DAYS } from '@entities/inventory';
import { version as appVersion } from '../../package.json';
import {
  APP_CACHE_BUSTER,
  DEHYDRATE_OPTIONS,
  PERSIST_MAX_AGE_MS,
  PERSISTED_QUERY_KEYS,
  createIdbPersister,
  keepLastGoodData,
  shouldDehydrateQuery,
  shouldPersistQuery,
  syncOnlineManagerWithConnectivity,
} from './queryPersister';
import { probeReachability } from '@shared/lib/connectivity';

const IDB_KEY = 'pos.query-cache';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  idb.store.clear();
  idb.fail = false;
});

describe('shouldPersistQuery', () => {
  it('persists the catalog and pricing data an offline till needs', () => {
    expect(shouldPersistQuery(['products'])).toBe(true);
    expect(shouldPersistQuery(['categories'])).toBe(true);
    expect(shouldPersistQuery(['promotions'])).toBe(true);
    expect(shouldPersistQuery(['receipt_settings'])).toBe(true);
    expect(shouldPersistQuery(['settings'])).toBe(true);
    expect(shouldPersistQuery(['role_permissions', 'list'])).toBe(true);
    expect(shouldPersistQuery(['staff', 'list'])).toBe(true);
  });

  it('refuses everything not on the allowlist', () => {
    expect(shouldPersistQuery(['tabs'])).toBe(false);
    expect(shouldPersistQuery(['payments'])).toBe(false);
    expect(shouldPersistQuery(['caja', 'session'])).toBe(false);
    expect(shouldPersistQuery(['reports', 'hourly'])).toBe(false);
    expect(shouldPersistQuery(['audit'])).toBe(false);
  });

  it('matches whole keys only, so a sibling key under an allowlisted head is never written to disk', () => {
    // A PIN rides in this key (AdminResetPinDialog) — it must never reach IndexedDB.
    expect(shouldPersistQuery(['staff', 'pinHolder', 'staff-1', '123456'])).toBe(false);
    expect(shouldPersistQuery(['staff'])).toBe(false);
    expect(shouldPersistQuery(['staff', 'openShifts'])).toBe(false);
    expect(shouldPersistQuery(['settings', 'backups'])).toBe(false);
    expect(shouldPersistQuery(['settings', 'email-status'])).toBe(false);
    expect(shouldPersistQuery(['products', 'p1', 'suppliers'])).toBe(false);
    expect(shouldPersistQuery(['role_permissions'])).toBe(false);
  });

  it('refuses an empty or non-string key', () => {
    expect(shouldPersistQuery([])).toBe(false);
    expect(shouldPersistQuery([{ nope: true }])).toBe(false);
  });

  it('keeps the allowlist explicit and short', () => {
    expect(PERSISTED_QUERY_KEYS.length).toBeLessThanOrEqual(8);
  });
});

describe('shouldDehydrateQuery', () => {
  function stateOf(queryKey: readonly unknown[], data: unknown) {
    const qc = new QueryClient();
    qc.setQueryData(queryKey, data);
    const query = qc.getQueryCache().find({ queryKey, exact: true });
    if (!query) throw new Error('query not built');
    return query;
  }

  it('writes a successful allowlisted Result to disk', () => {
    expect(shouldDehydrateQuery(stateOf(['products'], { ok: true, data: [] }))).toBe(true);
  });

  it('never writes an error Result to disk', () => {
    const errData = { ok: false, error: { code: 'NETWORK_OFFLINE', message: 'offline' } };
    expect(shouldDehydrateQuery(stateOf(['products'], errData))).toBe(false);
  });

  it('never writes a non-allowlisted query to disk', () => {
    expect(shouldDehydrateQuery(stateOf(['tabs'], { ok: true, data: [] }))).toBe(false);
  });
});

describe('DEHYDRATE_OPTIONS', () => {
  it('never writes a mutation to disk, even a paused one carrying a PIN', () => {
    const qc = new QueryClient();
    qc.getMutationCache().build(
      qc,
      { mutationKey: ['admin-reset-pin'], mutationFn: () => Promise.resolve() },
      { isPaused: true, status: 'pending', variables: { newPin: '123456' } } as never
    );
    expect(dehydrate(qc).mutations).toHaveLength(1); // TanStack's default would persist it

    expect(dehydrate(qc, DEHYDRATE_OPTIONS).mutations).toHaveLength(0);
  });
});

describe('APP_CACHE_BUSTER', () => {
  it('changes with every release, so a payload from an older build is never restored into new code', () => {
    expect(APP_CACHE_BUSTER).toContain(appVersion);
  });
});

describe('keepLastGoodData', () => {
  const good = { ok: true, data: [{ id: 'p1', barcode: '123' }] };
  const offline = { ok: false, error: { code: 'NETWORK_OFFLINE', message: 'offline' } };

  it('keeps the last good catalog when a refetch resolves to an error Result, without making it look fresh', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['products'], good, { updatedAt: 1000 });

    await qc.fetchQuery({ queryKey: ['products'], queryFn: () => Promise.resolve(offline), staleTime: 0 });

    expect(qc.getQueryData(['products'])).toEqual(good);
    expect(qc.getQueryState(['products'])?.dataUpdatedAt).toBe(1000);
    stop();
  });

  it('lets a later good Result replace the kept one', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['products'], good, { updatedAt: 1000 });
    const fresher = { ok: true, data: [{ id: 'p2', barcode: '999' }] };

    await qc.fetchQuery({ queryKey: ['products'], queryFn: () => Promise.resolve(fresher), staleTime: 0 });

    expect(qc.getQueryData(['products'])).toEqual(fresher);
    stop();
  });

  it('keeps the last good data for a transport failure surfaced as a Supabase error', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['products'], good, { updatedAt: 1000 });
    const transport = { ok: false, error: { code: 'SUPABASE_ERROR', message: 'TypeError: Failed to fetch' } };

    await qc.fetchQuery({ queryKey: ['products'], queryFn: () => Promise.resolve(transport), staleTime: 0 });

    expect(qc.getQueryData(['products'])).toEqual(good);
    stop();
  });

  it('a list that keeps changing keeps the last good data', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['promotions'], good, { updatedAt: 1000 });
    const changing = { ok: false, error: { code: 'LIST_CHANGED', message: 'list changed while it was paged' } };

    await qc.fetchQuery({ queryKey: ['promotions'], queryFn: () => Promise.resolve(changing), staleTime: 0 });

    expect(qc.getQueryData(['promotions'])).toEqual(good);
    stop();
  });

  it('lets a genuine server error through while the backend is reachable, so it is not hidden behind stale data', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['products'], good, { updatedAt: 1000 });
    const denied = { ok: false, error: { code: 'AUTH_FORBIDDEN', message: 'permission denied for table products' } };

    await qc.fetchQuery({ queryKey: ['products'], queryFn: () => Promise.resolve(denied), staleTime: 0 });

    expect(qc.getQueryData(['products'])).toEqual(denied);
    stop();
  });

  it('leaves non-allowlisted queries alone', async () => {
    const qc = new QueryClient();
    const stop = keepLastGoodData(qc);
    qc.setQueryData(['tabs'], good, { updatedAt: 1000 });

    await qc.fetchQuery({ queryKey: ['tabs'], queryFn: () => Promise.resolve(offline), staleTime: 0 });

    expect(qc.getQueryData(['tabs'])).toEqual(offline);
    stop();
  });
});

describe('createIdbPersister', () => {
  function persistedClient(queries: { key: string; dataUpdatedAt: number }[]) {
    return JSON.stringify({
      timestamp: Date.now(),
      buster: APP_CACHE_BUSTER,
      clientState: {
        mutations: [],
        queries: queries.map(({ key, dataUpdatedAt }) => ({
          queryKey: [key],
          queryHash: JSON.stringify([key]),
          state: { data: { ok: true, data: [] }, dataUpdatedAt, status: 'success' },
        })),
      },
    });
  }

  it('drops any query whose data is older than the max age, however recently the cache was saved', async () => {
    idb.store.set(
      IDB_KEY,
      persistedClient([
        { key: 'products', dataUpdatedAt: Date.now() - DAY },
        { key: 'promotions', dataUpdatedAt: Date.now() - PERSIST_MAX_AGE_MS - DAY },
      ])
    );

    const restored = await createIdbPersister().restoreClient();

    expect(restored?.clientState.queries.map(q => q.queryKey[0])).toEqual(['products']);
  });

  it('round-trips the Map, Set and Date values allowlisted queries cache (permissions, promotion windows)', async () => {
    const startsAt = new Date('2026-09-01T06:00:00.000Z');
    const permissions = new Map([['cashier', new Set(['create_order', 'clock_in'])]]);
    const persister = createIdbPersister();
    await persister.persistClient({
      timestamp: Date.now(),
      buster: APP_CACHE_BUSTER,
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: ['role_permissions', 'list'],
            queryHash: '["role_permissions","list"]',
            state: { data: { ok: true, data: permissions }, dataUpdatedAt: Date.now(), status: 'success' },
          },
          {
            queryKey: ['promotions'],
            queryHash: '["promotions"]',
            state: { data: { ok: true, data: [{ id: 'promo-1', startsAt }] }, dataUpdatedAt: Date.now(), status: 'success' },
          },
        ],
      },
    } as unknown as Parameters<typeof persister.persistClient>[0]);

    const restored = await createIdbPersister().restoreClient();
    const [perms, promos] = (restored?.clientState.queries ?? []).map(q => (q.state.data as { data: unknown }).data);

    expect(perms).toBeInstanceOf(Map);
    expect((perms as Map<string, Set<string>>).get('cashier')).toEqual(new Set(['create_order', 'clock_in']));
    const restoredStart = (promos as { startsAt: unknown }[])[0]?.startsAt;
    expect(restoredStart).toBeInstanceOf(Date);
    expect((restoredStart as Date).toISOString()).toBe(startsAt.toISOString());
  });

  // Without this an offline till prices every near-expiry item without the tier after a reload,
  // and each such sale is refused on replay. Expiry dates only: no stock figure is persisted.
  it('near-expiry pricing data survives an offline reload', async () => {
    const qc = new QueryClient();
    const dates = [{ productId: '33333333-3333-4333-8333-333333333333', expiryDate: '2026-10-23' }];
    qc.setQueryData(inventoryKeys.nearExpiryPricing(14), { ok: true, data: dates });
    const persister = createIdbPersister();
    await persister.persistClient({
      timestamp: Date.now(),
      buster: APP_CACHE_BUSTER,
      clientState: dehydrate(qc, DEHYDRATE_OPTIONS),
    });

    const restored = await createIdbPersister().restoreClient();

    expect(restored?.clientState.queries.map(q => q.queryKey)).toEqual([inventoryKeys.nearExpiryPricing(14)]);
    expect((restored?.clientState.queries[0]?.state.data as { data: unknown }).data).toEqual(dates);
  });

  it('the staff-facing near-expiry alert list and the inventory lists stay off the disk', () => {
    expect(shouldPersistQuery(inventoryKeys.nearExpiry(14))).toBe(false);
    expect(shouldPersistQuery(inventoryKeys.alerts())).toBe(false);
    expect(shouldPersistQuery(inventoryKeys.all)).toBe(false);
  });

  it('the pricing list reaches at least as far ahead as a restored catalog can be old', () => {
    expect(NEAR_EXPIRY_PRICING_LOOKAHEAD_DAYS * DAY).toBeGreaterThanOrEqual(PERSIST_MAX_AGE_MS);
  });

  it('restores nothing when IndexedDB is empty', async () => {
    await expect(createIdbPersister().restoreClient()).resolves.toBeUndefined();
  });
});

describe('PersistQueryClientProvider with createIdbPersister', () => {
  function Probe() {
    const { data } = useQuery({ queryKey: ['tabs'], queryFn: () => Promise.resolve('live') });
    return createElement('p', null, data ?? 'loading');
  }

  function renderApp() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      createElement(
        PersistQueryClientProvider,
        {
          client: qc,
          persistOptions: {
            persister: createIdbPersister(),
            maxAge: PERSIST_MAX_AGE_MS,
            buster: APP_CACHE_BUSTER,
          },
        },
        createElement(Probe)
      )
    );
  }

  it('still renders and queries when IndexedDB throws (private browsing, blocked site data)', async () => {
    idb.fail = true;
    renderApp();
    expect(await screen.findByText('live')).toBeTruthy();
  });

  it('still renders and queries when the stored payload is corrupt', async () => {
    idb.store.set(IDB_KEY, 'not-json{');
    renderApp();
    expect(await screen.findByText('live')).toBeTruthy();
  });
});

describe('syncOnlineManagerWithConnectivity', () => {
  it('takes TanStack offline when the backend is unreachable with the network card still up, and back online after', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubEnv('VITE_SUPABASE_URL', 'http://supabase.test');
    const realFetch = globalThis.fetch;
    syncOnlineManagerWithConnectivity();

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await probeReachability();
    expect(onlineManager.isOnline()).toBe(false);

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeReachability();
    expect(onlineManager.isOnline()).toBe(true);

    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

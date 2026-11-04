import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { onlineManager, type Query, type QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { isOnline, isUnreachableFailure, subscribeConnectivity } from '@shared/lib/connectivity';
import { version } from '../../package.json';

/**
 * Only data a till needs to keep selling while offline. Deliberately an allowlist of
 * WHOLE keys, not prefixes: transactional data (tabs, payments, caja, reports, audit)
 * must never be written to disk, and neither must a sibling key under an allowed head
 * (['staff', 'pinHolder', id, newPin] carries a PIN).
 */
export const PERSISTED_QUERY_KEYS: readonly (readonly string[])[] = [
  ['products'],
  ['categories'],
  ['promotions'],
  ['settings'],
  ['receipt_settings'],
  ['role_permissions', 'list'],
  ['staff', 'list'],
  // Expiry dates only (product id + date, no stock figure): the near-expiry tier is priced from
  // them, and without them an offline till after a reload prices no tier and every such sale is
  // refused on replay (Ruling 14 keeps stock NUMBERS out of the cache; this is not one).
  // (keyed by the threshold it was fetched for: see `isNearExpiryPricingKey`)
];

/** `['inventory', 'near-expiry-pricing', thresholdDays]`: whole-key like the rest, with one numeric tail. */
const isNearExpiryPricingKey = (key: readonly unknown[]): boolean =>
  key.length === 3 && key[0] === 'inventory' && key[1] === 'near-expiry-pricing' && typeof key[2] === 'number';

/**
 * Includes the release version, so every release discards the previous build's
 * payload; bump the prefix for a shape change within one version (dev builds).
 */
export const APP_CACHE_BUSTER = `v2:${version}`;

/** Bounds how old persisted data may be when restored on a cold start. */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldPersistQuery(key: readonly unknown[]): boolean {
  return (
    isNearExpiryPricingKey(key) ||
    PERSISTED_QUERY_KEYS.some(
      (allowed) => allowed.length === key.length && allowed.every((part, i) => part === key[i])
    )
  );
}

// Every allowlisted queryFn returns a Result as data, so a failure lands as
// status 'success' with an { ok: false } payload.
function isErrResult(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'ok' in data && data.ok === false;
}

function isTransportErr(data: unknown): boolean {
  if (!isErrResult(data)) return false;
  const { error } = data as { error?: { code?: string; message?: string } };
  return error?.code === 'LIST_CHANGED' || isUnreachableFailure(error?.code ?? '', error?.message ?? '');
}

export function shouldDehydrateQuery(query: Query): boolean {
  return (
    query.state.status === 'success' &&
    shouldPersistQuery(query.queryKey) &&
    !isErrResult(query.state.data)
  );
}

/**
 * Mutations are never written to disk: their variables can carry a PIN
 * (useAdminResetPin, useCreateStaff), and TanStack's default persists any paused one.
 */
export const DEHYDRATE_OPTIONS = {
  shouldDehydrateQuery,
  shouldDehydrateMutation: () => false,
};

/**
 * A refetch while the backend is unreachable resolves to an Err Result, which would
 * replace the catalog restored from disk (and then be persisted over it). Restore
 * TanStack's native "keep the last data on error" for allowlisted keys, keeping the
 * original dataUpdatedAt so the restore-time age bound stays honest.
 */
export function keepLastGoodData(queryClient: QueryClient): () => void {
  const lastGood = new WeakMap<Query, { data: unknown; updatedAt: number }>();
  return queryClient.getQueryCache().subscribe((event) => {
    const query = event.query as Query;
    if (!shouldPersistQuery(query.queryKey)) return;
    const { data, dataUpdatedAt } = query.state;
    if (data === undefined) return;
    if (!isErrResult(data)) {
      lastGood.set(query, { data, updatedAt: dataUpdatedAt });
      return;
    }
    // Only a request that never reached the server: a genuine server error while
    // reachable (RLS, 500) must surface, not hide behind stale data.
    const good = lastGood.get(query);
    if (good && isTransportErr(data)) {
      queryClient.setQueryData(query.queryKey, good.data, { updatedAt: good.updatedAt });
    }
  });
}

/**
 * TanStack's onlineManager only hears the window online/offline events, so a WAN
 * outage behind a live network card never pauses retries, and its recovery never
 * triggers refetchOnReconnect. Drive it from the reachability probe instead.
 */
export function syncOnlineManagerWithConnectivity(): void {
  onlineManager.setEventListener((setOnline) =>
    subscribeConnectivity(() => {
      setOnline(isOnline());
    })
  );
}

const IDB_KEY = 'pos.query-cache';

// Plain JSON loses types the allowlisted queries cache: role_permissions holds a
// Map<role, Set<action>>, promotions/products hold Dates. Tag them on the way out
// and rebuild them on the way in, or a restored cache crashes usePermissions and
// prices promotions against strings.
const TYPE_TAG = '__posType';

function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key]; // Date.toJSON already ran on `value`; the holder still has the Date.
  if (raw instanceof Date) return { [TYPE_TAG]: 'Date', v: raw.toISOString() };
  if (value instanceof Map) return { [TYPE_TAG]: 'Map', v: [...value] };
  if (value instanceof Set) return { [TYPE_TAG]: 'Set', v: [...value] };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !(TYPE_TAG in value)) return value;
  const { [TYPE_TAG]: type, v } = value as { [TYPE_TAG]: string; v: unknown };
  if (type === 'Date') return new Date(v as string);
  if (type === 'Map') return new Map(v as [unknown, unknown][]);
  if (type === 'Set') return new Set(v as unknown[]);
  return value;
}

/**
 * IndexedDB-backed persister. Never throws into the provider tree: a read failure
 * (private browsing, blocked site data) or a corrupt payload makes the restore reject,
 * which PersistQueryClientProvider turns into an empty in-memory cache; write failures
 * are swallowed by the async persister.
 */
export function createIdbPersister(): Persister {
  const inner = createAsyncStoragePersister({
    storage: {
      getItem: async (k) => ((await get<string>(k)) ?? null),
      setItem: (k, v) => set(k, v),
      removeItem: (k) => del(k),
    },
    key: IDB_KEY,
    throttleTime: 2000,
    serialize: (client) => JSON.stringify(client, replacer),
    deserialize: (cached) => JSON.parse(cached, reviver) as PersistedClient,
  });
  return {
    ...inner,
    restoreClient: async () => {
      const client = await inner.restoreClient();
      if (!client) return client;
      // persistedClient.timestamp is the last SAVE, refreshed on every launch, so
      // maxAge alone never ages out data a terminal has been restoring offline for weeks.
      const cutoff = Date.now() - PERSIST_MAX_AGE_MS;
      return {
        ...client,
        clientState: {
          ...client.clientState,
          queries: client.clientState.queries.filter((q) => q.state.dataUpdatedAt >= cutoff),
        },
      };
    },
  };
}

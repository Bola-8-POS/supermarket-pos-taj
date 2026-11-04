/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** jsdom has no `navigator.locks`; define it on the instance for one case and remove it after. */
const setLocks = (locks: unknown) => {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
};

/** A tiny Web Locks implementation with the one semantic that matters: ifAvailable is refused while held. */
function installLocks(held = new Set<string>()) {
  const request = vi.fn(
    (
      name: string,
      _options: { ifAvailable?: boolean },
      callback: (lock: { name: string } | null) => unknown
    ) => {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name }));
    }
  );
  setLocks({ request });
  return { request, held };
}

/** A fresh module per case: the lock is requested once, at module load. */
async function load() {
  vi.resetModules();
  const mod = await import('./instance-lock');
  // the request settles in the first tick
  await Promise.resolve();
  await Promise.resolve();
  return mod;
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

describe('instance lock', () => {
  it('without the Web Locks API the instance is primary', async () => {
    setLocks(undefined);
    const { getInstanceRole } = await load();
    expect(getInstanceRole()).toBe('primary');
  });

  it('the first instance is primary and a second one, finding the lock held, is secondary', async () => {
    const { held } = installLocks();
    const first = await load();
    expect(first.getInstanceRole()).toBe('primary');
    expect(held.has('pos-offline-sales-primary')).toBe(true);

    const second = await load();
    expect(second.getInstanceRole()).toBe('secondary');
  });

  it('requesting the lock twice in one document keeps it primary', async () => {
    const { request } = installLocks();
    const mod = await load();
    expect(mod.getInstanceRole()).toBe('primary');

    // a second request from the same document (StrictMode, a second import path) must not be a second contender
    mod.requestInstanceLock();
    mod.requestInstanceLock();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(mod.getInstanceRole()).toBe('primary');
  });

  it('the role is unknown until the request settles, and subscribers hear the change', async () => {
    let grant: (lock: { name: string } | null) => unknown = () => undefined;
    setLocks({
      request: (_n: string, _o: unknown, cb: typeof grant) =>
        new Promise(resolve => {
          grant = lock => {
            resolve(cb(lock));
            return undefined;
          };
        }),
    });
    vi.resetModules();
    const mod = await import('./instance-lock');
    const heard: string[] = [];
    mod.subscribeInstanceRole(() => {
      heard.push(mod.getInstanceRole());
    });
    expect(mod.getInstanceRole()).toBe('unknown');

    grant({ name: 'x' });
    expect(mod.getInstanceRole()).toBe('primary');
    expect(heard).toEqual(['primary']);
  });

  it('the product peek window never asks for the lock', async () => {
    window.history.pushState({}, '', '/?window=peek');
    const { request } = installLocks();
    const mod = await load();
    expect(request).not.toHaveBeenCalled();
    expect(mod.getInstanceRole()).toBe('unknown');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmNavigation, installPopstateGuard, useNavigationGuardStore } from './navigation-guard';

describe('navigation-guard', () => {
  beforeEach(() => {
    useNavigationGuardStore.setState({ guard: null });
  });

  it('resolves true when no guard is installed', async () => {
    await expect(confirmNavigation()).resolves.toBe(true);
  });

  it('delegates to the installed guard', async () => {
    const guard = vi.fn().mockResolvedValue(false);
    useNavigationGuardStore.getState().setGuard(guard);
    await expect(confirmNavigation()).resolves.toBe(false);
    expect(guard).toHaveBeenCalledOnce();
  });

  it('resolves true (fail-open) if the guard throws', async () => {
    useNavigationGuardStore.getState().setGuard(() => Promise.reject(new Error('x')));
    await expect(confirmNavigation()).resolves.toBe(true);
  });
});

function popstate(): Promise<void> {
  return new Promise(resolve => {
    window.addEventListener('popstate', () => { resolve(); }, { once: true });
  });
}

async function back(): Promise<void> {
  const settled = popstate();
  window.history.back();
  await settled;
}

describe('installPopstateGuard', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('an attempt while installed calls onAttempt and keeps the URL', async () => {
    window.history.pushState(null, '', '/prev');
    window.history.pushState(null, '', '/settings');
    const onAttempt = vi.fn();
    const uninstall = installPopstateGuard(onAttempt);

    await back();

    expect(onAttempt).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/settings');
    uninstall();
  });

  it('proceed navigates back exactly once, to the page before', async () => {
    window.history.pushState(null, '', '/prev');
    window.history.pushState(null, '', '/settings');
    let proceed: () => void = () => undefined;
    const onAttempt = vi.fn((p: () => void) => { proceed = p; });
    installPopstateGuard(onAttempt);
    await back();

    const settled = popstate();
    proceed();
    proceed();
    await settled;

    expect(window.location.pathname).toBe('/prev');
    expect(onAttempt).toHaveBeenCalledOnce();
  });

  it('uninstall removes the listener', async () => {
    window.history.pushState(null, '', '/prev');
    window.history.pushState(null, '', '/settings');
    const onAttempt = vi.fn();
    const uninstall = installPopstateGuard(onAttempt);
    uninstall();

    await back();

    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('proceed still leaves after uninstall (page went clean before the continuation ran)', async () => {
    window.history.pushState(null, '', '/prev');
    window.history.pushState(null, '', '/settings');
    let proceed: () => void = () => undefined;
    const uninstall = installPopstateGuard(p => { proceed = p; });
    await back();

    uninstall();
    const settled = popstate();
    proceed();
    await settled;

    expect(window.location.pathname).toBe('/prev');
  });
});

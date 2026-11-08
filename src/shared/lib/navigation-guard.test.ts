import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmNavigation, useNavigationGuardStore } from './navigation-guard';

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

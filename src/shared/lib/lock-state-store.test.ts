import { beforeEach, describe, expect, it } from 'vitest';
import { useLockStateStore } from './lock-state-store';

describe('useLockStateStore persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useLockStateStore.setState({ locked: false });
  });

  it('writes locked=true to localStorage["lock-state"]', () => {
    useLockStateStore.getState().setLocked(true);
    const raw = localStorage.getItem('lock-state');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.locked).toBe(true);
  });

  it('rehydrates locked=true from localStorage on a fresh store', async () => {
    localStorage.setItem('lock-state', JSON.stringify({ state: { locked: true }, version: 0 }));
    await useLockStateStore.persist.rehydrate();
    expect(useLockStateStore.getState().locked).toBe(true);
  });
});

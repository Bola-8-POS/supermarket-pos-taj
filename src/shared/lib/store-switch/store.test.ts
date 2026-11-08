/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked handles on the mocked client, and Storage.prototype is patched and restored */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearMovedFlag,
  currentStoreSwitchState,
  movedFlagKey,
  readMovedFlag,
  useStoreSwitchStore,
  writeMovedFlag,
} from './store';

beforeEach(() => {
  localStorage.clear();
  useStoreSwitchStore.setState({ state: 'active' });
});

describe('store switch store', () => {
  it('starts active and reports what was set', () => {
    expect(currentStoreSwitchState()).toBe('active');
    useStoreSwitchStore.getState().setState('moved');
    expect(currentStoreSwitchState()).toBe('moved');
  });

  it('keeps the moved flag per backend, so a till paired to another server does not inherit it', () => {
    writeMovedFlag('https://cloud.example.invalid');
    expect(readMovedFlag('https://cloud.example.invalid')).toBe(true);
    expect(readMovedFlag('https://store-server.local:47304')).toBe(false);
    expect(movedFlagKey('x')).toBe('pos.store_moved:x');
    clearMovedFlag('https://cloud.example.invalid');
    expect(readMovedFlag('https://cloud.example.invalid')).toBe(false);
  });

  it('survives an unavailable localStorage', () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      expect(readMovedFlag('x')).toBe(false);
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});

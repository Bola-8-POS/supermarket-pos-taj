import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useKeypadVisible } from './useKeypadVisible';

const STORAGE_KEY = 'pos.payment_keypad_visible';

describe('useKeypadVisible', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('defaults to true when storage is empty', () => {
    const { result } = renderHook(() => useKeypadVisible());
    expect(result.current[0]).toBe(true);
  });

  test('setVisible(false) writes "false" to storage', () => {
    const { result } = renderHook(() => useKeypadVisible());
    act(() => {
      result.current[1](false);
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(result.current[0]).toBe(false);
  });

  test('reading a stored "false" yields false on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { result } = renderHook(() => useKeypadVisible());
    expect(result.current[0]).toBe(false);
  });

  test('a storage read that throws does not crash and defaults to true', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const { result } = renderHook(() => useKeypadVisible());
    expect(result.current[0]).toBe(true);
  });

  test('a storage write that throws does not crash and still updates in-memory state', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const { result } = renderHook(() => useKeypadVisible());
    expect(() => {
      act(() => {
        result.current[1](false);
      });
    }).not.toThrow();
    expect(result.current[0]).toBe(false);
  });
});

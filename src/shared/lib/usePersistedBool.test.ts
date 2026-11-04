import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePersistedBool } from './usePersistedBool';

describe('usePersistedBool', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns the default when nothing is stored', () => {
    const { result } = renderHook(() => usePersistedBool('flag-a', false));
    expect(result.current[0]).toBe(false);
  });

  it('reads a previously stored truthy value', () => {
    window.localStorage.setItem('bola8pos:ui:flag-b', '1');
    const { result } = renderHook(() => usePersistedBool('flag-b', false));
    expect(result.current[0]).toBe(true);
  });

  it('persists updates to localStorage', () => {
    const { result } = renderHook(() => usePersistedBool('flag-c', false));
    act(() => {
      result.current[1](true);
    });
    expect(window.localStorage.getItem('bola8pos:ui:flag-c')).toBe('1');
  });

  it('accepts an updater function', () => {
    const { result } = renderHook(() => usePersistedBool('flag-d', true));
    act(() => {
      result.current[1](prev => !prev);
    });
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem('bola8pos:ui:flag-d')).toBe('0');
  });
});

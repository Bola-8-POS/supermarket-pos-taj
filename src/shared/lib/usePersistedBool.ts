import { useCallback, useEffect, useState } from 'react';

const KEY_PREFIX = 'bola8pos:ui:';

function readInitial(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

export function usePersistedBool(
  key: string,
  defaultValue: boolean
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => readInitial(key, defaultValue));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(KEY_PREFIX + key, value ? '1' : '0');
    } catch {
      // localStorage may throw in private mode; ignore.
    }
  }, [key, value]);

  const set = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setValue(prev => (typeof next === 'function' ? next(prev) : next));
  }, []);

  return [value, set];
}

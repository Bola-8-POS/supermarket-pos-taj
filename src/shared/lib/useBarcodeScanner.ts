import { useEffect, useRef } from 'react';

type Options = {
  minLength?: number;
  maxGapMs?: number;
  onScan: (code: string) => void;
  enabled?: boolean;
};

const DEFAULTS = { minLength: 4, maxGapMs: 50 };

/**
 * USB HID barcode scanners emit rapid keystrokes ending with Enter.
 * This hook buffers characters globally; on Enter, if the buffer
 * length >= minLength, it fires onScan(code). Slow human typing
 * (gaps > maxGapMs) resets the buffer, so it does not interfere
 * with normal keyboard input — including typing directly into a focused
 * text input, which the gap timing alone is sufficient to tell apart from
 * a scanner burst (a focus-based skip would otherwise also swallow a real
 * scan whenever a text field happens to have focus).
 */
export function useBarcodeScanner({ onScan, enabled = true, ...rest }: Options) {
  const minLength = rest.minLength ?? DEFAULTS.minLength;
  const maxGapMs = rest.maxGapMs ?? DEFAULTS.maxGapMs;
  const bufferRef = useRef<string>('');
  const lastKeyAtRef = useRef<number>(0);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    function handler(e: KeyboardEvent) {
      const now = Date.now();
      const gap = now - lastKeyAtRef.current;
      lastKeyAtRef.current = now;

      if (e.key === 'Enter') {
        const code = bufferRef.current;
        bufferRef.current = '';
        if (code.length >= minLength) {
          onScanRef.current(code);
        }
        return;
      }

      if (gap > maxGapMs) {
        bufferRef.current = '';
      }

      if (e.key.length === 1) {
        bufferRef.current += e.key;
      }
    }

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [enabled, minLength, maxGapMs]);
}

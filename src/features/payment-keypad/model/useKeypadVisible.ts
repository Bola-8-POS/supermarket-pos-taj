/**
 * useKeypadVisible — per-terminal show/hide preference for the payment
 * amount keypad, persisted the same way as src/shared/lib/terminal.ts's
 * getTerminalId/setTerminalId: a single localStorage key, wrapped in
 * try/catch so a disabled/unavailable storage never crashes checkout.
 */
import { useState } from 'react';

export const KEYPAD_VISIBLE_STORAGE_KEY = 'pos.payment_keypad_visible';

function readStored(): boolean {
  try {
    return localStorage.getItem(KEYPAD_VISIBLE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function useKeypadVisible(): [visible: boolean, setVisible: (v: boolean) => void] {
  const [visible, setVisibleState] = useState<boolean>(readStored);

  const setVisible = (v: boolean) => {
    setVisibleState(v);
    try {
      localStorage.setItem(KEYPAD_VISIBLE_STORAGE_KEY, String(v));
    } catch {
      /* ponytail: localStorage unavailable — visibility stays in-memory for this session */
    }
  };

  return [visible, setVisible];
}

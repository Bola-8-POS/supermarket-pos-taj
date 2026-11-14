import { isDemoAutoStart } from './license/config';
import { err, ok, type Result } from './result';

export const TERMINAL_ID_STORAGE_KEY = 'pos.terminal_id';
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_TERMINAL_ID = 'POS-1';

function readStored(): string | null {
  try {
    const v = localStorage.getItem(TERMINAL_ID_STORAGE_KEY);
    return v && TERMINAL_ID_PATTERN.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** DEMO-xxxxxx (6 hex chars) — satisfies TERMINAL_ID_PATTERN. */
function mintDemoTerminalId(): string {
  const hex = Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `DEMO-${hex}`;
}

/** Per-install terminal identity: Settings → Hardware (localStorage) → VITE_TERMINAL_ID → POS-1.
 * Online-demo build (VITE_DEMO_AUTO_START) is the one exception: with nothing stored yet, mint a
 * random DEMO-xxxxxx id once and persist it, so every browser visiting the shared demo build gets
 * its own caja session instead of all colliding on POS-1. */
export function getTerminalId(): string {
  const stored = readStored();
  if (stored) return stored;
  if (isDemoAutoStart()) {
    const minted = mintDemoTerminalId();
    try {
      localStorage.setItem(TERMINAL_ID_STORAGE_KEY, minted);
    } catch {
      /* ponytail: localStorage unavailable — falls through, re-minted next call */
    }
    return minted;
  }
  const env = (import.meta.env.VITE_TERMINAL_ID as string | undefined)?.trim();
  return env && TERMINAL_ID_PATTERN.test(env) ? env : DEFAULT_TERMINAL_ID;
}

export function setTerminalId(raw: string): Result<void> {
  const id = raw.trim();
  if (!TERMINAL_ID_PATTERN.test(id)) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Terminal id must be 1-32 chars: letters, digits, _ or -',
    });
  }
  try {
    localStorage.setItem(TERMINAL_ID_STORAGE_KEY, id);
  } catch {
    /* ponytail: localStorage unavailable — value stays env/default for this session */
  }
  return ok(undefined);
}

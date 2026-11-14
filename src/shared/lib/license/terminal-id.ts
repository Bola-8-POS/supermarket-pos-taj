import { getTerminalId as getSharedTerminalId } from '../terminal';

const TERMINAL_ID_KEY = 'pos.license.terminal_id';

/** In-memory fallback so a locked-down localStorage still yields a stable ID within the session. */
let _memoryFallbackId: string | null = null;

/**
 * Stable per-installation UUID, minted once and kept in localStorage (WebView2 persists
 * it in the app's user-data dir). The license server keys terminals by this value.
 * ponytail: no hardware fingerprint — the portal's revoke button covers a copied install.
 */
export function getTerminalId(): string {
  try {
    const existing = localStorage.getItem(TERMINAL_ID_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(TERMINAL_ID_KEY, fresh);
    return fresh;
  } catch {
    // localStorage unavailable (disabled/quota) — cache in memory so activate() and the
    // follow-up applyToken() within the same session see the same ID, instead of each
    // call minting a fresh UUID and failing the server's terminal_id match check.
    _memoryFallbackId ??= crypto.randomUUID();
    return _memoryFallbackId;
  }
}

/** Web demo only: forget this browser's terminal so the server issues a fresh demo. */
export function resetTerminalId(): string {
  try {
    localStorage.removeItem(TERMINAL_ID_KEY);
  } catch {
    /* memory fallback below */
  }
  _memoryFallbackId = null;
  return getTerminalId();
}

/** Human label shown in the portal — reuses the caja terminal label already in use. */
export function getTerminalName(): string {
  return getSharedTerminalId();
}

export function getPlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  if (/Mac/i.test(ua)) return 'macos';
  return 'unknown';
}

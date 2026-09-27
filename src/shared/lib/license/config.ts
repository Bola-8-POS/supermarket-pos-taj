/**
 * License-server connection + enforcement flag.
 *
 * Enforcement default: ON in production builds, OFF in dev / e2e. Override either way
 * with VITE_LICENSE_ENFORCE=true|false at build time. The server URL/anon key come from
 * VITE_LICENSE_SERVER_URL / VITE_LICENSE_SERVER_ANON_KEY, or at runtime from the Tauri
 * `.env` next to the executable (AppConfigProvider → initLicenseConfig).
 */
let _url: string | null =
  import.meta.env.VITE_LICENSE_SERVER_URL?.trim().replace(/\/$/, '') || null;
let _anonKey: string | null = import.meta.env.VITE_LICENSE_SERVER_ANON_KEY?.trim() || null;

export function initLicenseConfig(url: string | undefined, anonKey: string | undefined): void {
  if (url?.trim()) _url = url.trim().replace(/\/$/, '');
  if (anonKey?.trim()) _anonKey = anonKey.trim();
}

export function getLicenseServerUrl(): string | null {
  return _url;
}

export function getLicenseServerAnonKey(): string | null {
  return _anonKey;
}

export function isLicenseEnforced(): boolean {
  const flag = import.meta.env.VITE_LICENSE_ENFORCE?.trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return import.meta.env.PROD;
}

/** Heartbeat cadence — 6 h keeps a 60-day lease refreshed with ~240 attempts of margin. */
export const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Online-demo build: the gate self-provisions a demo instead of asking for a key. */
export function isDemoAutoStart(): boolean {
  const flag = import.meta.env.VITE_DEMO_AUTO_START?.trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

/** Where the upgrade dialog sends prospects. */
export const DEMO_CONTACT = {
  site: import.meta.env.VITE_DEMO_CONTACT_URL?.trim() || 'https://bola8pos.com',
  email: import.meta.env.VITE_DEMO_CONTACT_EMAIL?.trim() || 'hola@bola8pos.com',
} as const;

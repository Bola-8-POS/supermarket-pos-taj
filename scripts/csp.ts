/**
 * Single source of truth for every Content-Security-Policy string this repo
 * ships: the Tauri desktop shell (`src-tauri/tauri.conf.json`'s `csp`/
 * `devCsp`), the web demo build (`firebase.json`'s hosting header and the
 * Vite preview server used by the CSP Playwright suite), and the build-time
 * backend-host guard (`vite.config.ts`). A plain `.ts` module (not JSON) so
 * both `vite.config.ts` and the Vitest config test can import the exact same
 * constants instead of three independent copies drifting apart.
 *
 * `'wasm-unsafe-eval'` is required by `yoga-layout` (the WebAssembly layout
 * engine every `@react-pdf/renderer` export compiles), so it ships in every
 * policy, dev and production alike. `'unsafe-eval'` is dev-only (Vite's dev
 * client and the React refresh preamble) and must never appear in a shipped
 * policy — `DESKTOP_DEV_CSP` is the only export that carries it.
 */

/** Supabase project origins the app is ever allowed to reach, over https for
 * REST/Storage and wss for realtime. Shared between the CSP `connect-src`
 * directives and `isAllowedBackendUrl`'s allow-list description. */
export const SUPABASE_HOSTS = [
  'https://*.supabase.co',
  'https://*.supabase.in',
  'wss://*.supabase.co',
  'wss://*.supabase.in',
] as const;

const IMG_SRC = "img-src 'self' data: blob: https://*.supabase.co https://*.supabase.in";
const FONT_SRC = "font-src 'self' data:";
const STYLE_SRC = "style-src 'self' 'unsafe-inline'";
const WORKER_SRC = "worker-src 'self' blob:";
const OBJECT_SRC = "object-src 'none'";
const FRAME_SRC = "frame-src 'none'";
const BASE_URI = "base-uri 'self'";
const FORM_ACTION = "form-action 'self'";

/**
 * `data:` is required in `connect-src` (not just `img-src`/`font-src`) for
 * `@react-pdf/renderer`'s WebAssembly layout engine, `yoga-layout`: its
 * base64-inlined build (`node_modules/yoga-layout/dist/binaries/
 * yoga-wasm-base64-esm.js`) loads its wasm bytes with `fetch()` against a
 * `data:` URI, and a `fetch()` target is governed by `connect-src` per the
 * Fetch/CSP3 spec — `'wasm-unsafe-eval'` alone (which only covers the
 * instantiate/compile step) does not cover that fetch. Confirmed by running
 * the CSP Playwright suite against a real PDF export before this was added:
 * Chromium blocked it with "Connecting to 'data:application/octet-stream...'
 * violates the following Content Security Policy directive: connect-src...".
 */
const DATA_URI = 'data:';

/** Desktop connect-src: Supabase (https/wss), the broker over loopback HTTP,
 * and Tauri's own IPC origins. The loopback entries ship in production on
 * purpose — the runtime `.env` override (wave 3b) admits a loopback backend,
 * and the assistant's local-Ollama fallback is loopback too. */
const DESKTOP_CONNECT_SRC = [
  "'self'",
  DATA_URI,
  'ipc:',
  'http://ipc.localhost',
  ...SUPABASE_HOSTS,
  'http://127.0.0.1:*',
  'http://localhost:*',
  'ws://127.0.0.1:*',
  'ws://localhost:*',
].join(' ');

/** Web connect-src: no ipc:, no loopback — the web demo build never talks to
 * the print broker or a loopback dev backend. */
const WEB_CONNECT_SRC = ["'self'", DATA_URI, ...SUPABASE_HOSTS].join(' ');

function buildCsp(scriptSrc: string, connectSrc: string): string {
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    STYLE_SRC,
    IMG_SRC,
    FONT_SRC,
    `connect-src ${connectSrc}`,
    WORKER_SRC,
    OBJECT_SRC,
    FRAME_SRC,
    BASE_URI,
    FORM_ACTION,
  ].join('; ');
}

/** Shipped desktop policy (`tauri.conf.json` `app.security.csp`). */
export const DESKTOP_CSP = buildCsp("'self' 'wasm-unsafe-eval'", DESKTOP_CONNECT_SRC);

/** Dev-only desktop policy (`tauri.conf.json` `app.security.devCsp`) — adds
 * `'unsafe-inline' 'unsafe-eval'` to `script-src` for Vite's dev client and
 * the React refresh preamble. Never used for a shipped build. */
export const DESKTOP_DEV_CSP = buildCsp(
  "'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'",
  DESKTOP_CONNECT_SRC
);

/** Shipped web policy (`firebase.json` hosting header, the CSP Playwright
 * preview server). Same as `DESKTOP_CSP` minus the ipc:/loopback entries. */
export const WEB_CSP = buildCsp("'self' 'wasm-unsafe-eval'", WEB_CONNECT_SRC);

/**
 * The one allow-list rule for a runtime/build-time backend override, shared
 * by the desktop Rust side (`src-tauri/src/lib.rs::is_allowed_backend_url`,
 * kept in sync by hand — Rust cannot import this module) and the web
 * build-time guard (`vite.config.ts`): `https` to a host ending in
 * `.supabase.co`/`.supabase.in`, or `http`/`https` to `localhost`/
 * `127.0.0.1`. Checked on the parsed hostname alone, never a substring match
 * against the whole URL, so `https://evil.supabase.co.example.net`
 * (a real suffix match on the raw string but not on the parsed host) and a
 * userinfo trick (`https://x.supabase.co@evil.example/`) are both rejected.
 */
export function isAllowedBackendUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  if (parsed.protocol === 'https:') {
    return host.endsWith('.supabase.co') || host.endsWith('.supabase.in') || isLoopback;
  }
  if (parsed.protocol === 'http:') {
    return isLoopback;
  }
  return false;
}

// Per-request CORS headers. Reflects the caller's Origin
// when it is allow-listed, instead of the previous '*' every function set —
// '*' let any site call an authenticated endpoint from a browser. Building
// this from the request each time (not a module-level constant) also keeps
// one request's Origin from carrying over into a concurrent request's
// response.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://tauri.localhost',
  'tauri://localhost',
  'https://bola8pos-demo.web.app',
  'https://bola8pos-demo.firebaseapp.com',
  'https://demo.bola8pos.com',
]

// Covers the app's own dev port and every license-suite Playwright config's
// port on loopback, without hardcoding each one. Loopback is not reachable
// by a third party, so matching any port on it is not a real widening.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function allowListFromEnv(): string[] | null {
  const raw = Deno.env.get('ALLOWED_ORIGINS')
  if (!raw) return null
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return list.length > 0 ? list : null
}

function isOriginAllowed(origin: string): boolean {
  const configured = allowListFromEnv()
  if (configured) return configured.includes(origin)
  return DEFAULT_ALLOWED_ORIGINS.includes(origin) || LOOPBACK_ORIGIN.test(origin)
}

// Access-Control-Allow-Headers stays fixed across every function:
// supabase-js 2.103 only adds x-region when a region is configured, and none
// is here.
export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  }
  const origin = req.headers.get('Origin')
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

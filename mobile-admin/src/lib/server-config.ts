export type ServerConfig = { url: string; anonKey: string };
export type ServerConfigInput = { url: string; anonKey: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2']);

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local')) return true;

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first = -1, second = -1] = parts;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

function jwtRole(key: string): string | null {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(globalThis.atob(padded));
    return typeof parsed === 'object' && parsed !== null && 'role' in parsed && typeof parsed.role === 'string'
      ? parsed.role
      : null;
  } catch {
    return null;
  }
}

export function parseServerConfig(input: ServerConfigInput): ServerConfig {
  const rawUrl = input.url.trim();
  const anonKey = input.anonKey.trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Enter a valid Supabase URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The server URL must use HTTP or HTTPS.');
  if (parsed.username || parsed.password) throw new Error('Do not include credentials in the server URL.');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Enter the Supabase project base URL only.');
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    throw new Error('Remote Supabase projects must use HTTPS. Plain HTTP is limited to the local network.');
  }
  if (anonKey.length < 20) throw new Error("Enter the project's legacy anon key.");
  if (anonKey.startsWith('sb_secret_')) throw new Error('Never use a Supabase secret key in this app.');
  if (anonKey.startsWith('sb_publishable_')) {
    // staff-sign-in has verify_jwt = true, and the platform rejects a non-JWT key as Bearer.
    throw new Error("This app needs the project's legacy anon key (starts with eyJ). Publishable keys can't sign in yet.");
  }
  if (jwtRole(anonKey) === 'service_role') throw new Error('Never use a Supabase service-role key in this app.');

  return { url: parsed.origin, anonKey };
}

export async function verifyServerConfig(
  config: ServerConfig,
  request: typeof fetch = globalThis.fetch
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const response = await request(`${config.url}/rest/v1/staff_directory?select=id&limit=1`, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      signal: controller.signal,
    });
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new Error('The server rejected this anon or publishable key.');
    }
    if (response.status === 404) throw new Error('This server is not a compatible Bola 8 POS Supabase project.');
    throw new Error(`The Supabase server returned HTTP ${String(response.status)}.`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('The Supabase server timed out.');
    if (error instanceof Error && error.message.startsWith('The ')) throw error;
    throw new Error('Unable to reach this Supabase server. Check the URL and Wi-Fi connection.');
  } finally {
    clearTimeout(timeout);
  }
}

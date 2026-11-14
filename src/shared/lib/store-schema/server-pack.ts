import { z } from 'zod';
import { getProbeTarget } from '../connectivity';

const HEALTH_TIMEOUT_MS = 4000;
const HealthSchema = z.object({ packVersion: z.string().max(64) });
const PACK_RE = /^(\d+\.\d+\.\d+)-r\d+$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** `1.11.0-r1` -> `1.11.0`; null for any other shape. */
export function appVersionOf(packVersion: string): string | null {
  return PACK_RE.exec(packVersion)?.[1] ?? null;
}

/** Negative, zero or positive like a comparator; null when either side is not MAJOR.MINOR.PATCH. */
export function compareSemver(a: string, b: string): number | null {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** The installed pack version the store server reports (GET /_store/health, no key); null when fenced, unreachable or malformed. */
export async function fetchServerPackVersion(): Promise<string | null> {
  const target = getProbeTarget();
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${target.url}/_store/health`, { method: 'GET', cache: 'no-store', signal: controller.signal });
    if (res.status !== 200) return null;
    const parsed = HealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.packVersion : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Server first, tills second: an app update is installable only once the server pack has at least that appVersion. */
export async function serverReadyForAppVersion(updateVersion: string): Promise<'ready' | 'wait-server' | 'unparseable'> {
  const pack = await fetchServerPackVersion();
  if (pack === null) return 'wait-server';
  const serverApp = appVersionOf(pack);
  const cmp = serverApp === null ? null : compareSemver(serverApp, updateVersion);
  if (cmp === null) return 'unparseable';
  return cmp >= 0 ? 'ready' : 'wait-server';
}

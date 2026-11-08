import { z } from 'zod';
import { getProbeTarget } from '../connectivity';
import { logger } from '../logger-instance';
import { classify, type StoreSchemaState } from './classify';
import { getExpectedSchema } from './expected';

export const PROBE_TIMEOUT_MS = 4000;

// Same 14-digit rule as scripts/store-expected-schema.ts and the pack manifest builder: anything else is not a level.
const RowsSchema = z
  .array(z.object({ max_version: z.string().regex(/^\d{14}$/), applied: z.number().int().nonnegative() }))
  .length(1);

/** Last HTTP status logged as unexpected; the warning is emitted on change only (no URL, no key). */
let lastUnexpectedStatus = 0;
function noteStatus(status: number, expected: boolean): void {
  if (expected) {
    lastUnexpectedStatus = 0;
    return;
  }
  if (status !== lastUnexpectedStatus) logger.warn('store_schema.probe_unexpected_status', { status });
  lastUnexpectedStatus = status;
}

async function isUpdatingBody(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 'STORE_UPDATING';
  } catch {
    return false;
  }
}

/**
 * One GET of the store's schema level, classified per the plan's verdict table.
 * Raw fetch (not licenseGuardedFetch): a read, never gated, never the licence server.
 * Never throws; every failure is `unreachable` (the offline layer owns it).
 */
export async function probeStoreSchema(opts?: { signal?: AbortSignal }): Promise<StoreSchemaState> {
  const target = getProbeTarget();
  if (!target) return { kind: 'unreachable' };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  const onCallerAbort = (): void => {
    controller.abort();
  };
  opts?.signal?.addEventListener('abort', onCallerAbort);
  try {
    const res = await fetch(`${target.url}/rest/v1/store_schema_version?select=max_version,applied`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { apikey: target.anonKey },
    });
    if (res.status === 404) {
      noteStatus(404, true);
      return { kind: 'missing' };
    }
    // Static request: a 400 (renamed/missing column) is a shape mismatch, which the gate exists for.
    if (res.status === 400) {
      noteStatus(400, true);
      return { kind: 'missing' };
    }
    if (res.status === 503 && (await isUpdatingBody(res))) {
      noteStatus(503, true);
      return { kind: 'updating' };
    }
    if (res.status !== 200) {
      noteStatus(res.status, false);
      return { kind: 'unreachable' };
    }
    noteStatus(200, true);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { kind: 'missing' };
    }
    const parsed = RowsSchema.safeParse(json);
    if (!parsed.success) return { kind: 'missing' };
    const row = parsed.data[0];
    if (!row) return { kind: 'missing' };
    const server = { maxVersion: row.max_version, applied: row.applied };
    const verdict = classify(server, getExpectedSchema());
    return verdict === 'ok' ? { kind: 'ok' } : { kind: verdict, server };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onCallerAbort);
  }
}

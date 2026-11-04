/**
 * Shared local-only guard for every test helper, integration setup and seed
 * script that holds a service-role Supabase client. Plain Node: no imports,
 * so it is importable from src/, scripts/ and e2e/ alike (see
 * scripts/lib/service-client.ts and the call sites this guards).
 *
 * A destructive/service-role client is refused unless its URL's parsed
 * hostname is loopback (127.0.0.1, localhost, or [::1] as `URL` reports a
 * bracketed IPv6 literal) or the caller has named the exact remote origin in
 * the ALLOW_REMOTE_SUPABASE_URL environment variable (used by the one
 * deliberately-remote path, scripts/seed-remote-e2e-admin.ts, via
 * .env.remote-e2e, and by the nightly demo reset workflow).
 */

export const REMOTE_TARGET_ENV = 'ALLOW_REMOTE_SUPABASE_URL';

export class TestTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestTargetError';
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new TestTargetError('refusing test target: the Supabase URL is missing or unparseable');
  }
}

/**
 * Parses `rawUrl` and returns it when the target is safe to run a
 * service-role test/seed client against: loopback, or an explicitly
 * allow-listed remote origin. Throws TestTargetError otherwise. The
 * refusal message never carries a key, path or query string — only the
 * refused hostname and the variable name to set.
 */
export function assertLocalTestTarget(
  rawUrl: string | undefined,
  env: Record<string, string | undefined> = process.env
): URL {
  if (!rawUrl) {
    throw new TestTargetError('refusing test target: the Supabase URL is missing or unparseable');
  }
  const url = parseUrl(rawUrl);

  if (LOCAL_HOSTNAMES.has(url.hostname)) {
    return url;
  }

  const allowRaw = env[REMOTE_TARGET_ENV];
  if (allowRaw) {
    let allowUrl: URL;
    try {
      allowUrl = new URL(allowRaw);
    } catch {
      throw new TestTargetError(`refusing test target: ${REMOTE_TARGET_ENV} is set but is not a valid URL`);
    }
    if (allowUrl.origin === url.origin) {
      return url;
    }
  }

  throw new TestTargetError(
    `refusing non-local Supabase target ${url.hostname}; set ${REMOTE_TARGET_ENV}=<origin> to allow it`
  );
}

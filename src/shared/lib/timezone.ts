/**
 * The store timezone is an IANA name. Names the runtime lists are matched case-insensitively; any
 * other `Region/City` or `Etc/...` name (Asia/Kolkata, Etc/UTC, US/Central: all valid for Postgres)
 * is accepted when Intl resolves it, and the resolved name is the one used and saved. Offsets and
 * abbreviations (UTC-6, GMT-6, -06:00, EST) are never valid: Postgres reads them as POSIX with an
 * inverted sign, Intl does not.
 */
let byLowerCase: Map<string, string> | undefined;

// letters, digits, _ - + in "/"-separated segments, at least two segments (no bare EST / UTC-6)
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

function table(): Map<string, string> {
  if (!byLowerCase) {
    // eslint-disable-next-line i18next/no-literal-string -- IANA key, not UI copy
    // older runtimes lack supportedValuesOf: the Intl.DateTimeFormat check alone then decides
    const supported = Intl.supportedValuesOf as ((key: 'timeZone') => string[]) | undefined;
    const listed = supported?.('timeZone') ?? [];
    // eslint-disable-next-line i18next/no-literal-string -- IANA key, not UI copy
    byLowerCase = new Map([...listed, 'UTC'].map(name => [name.toLowerCase(), name] as const));
  }
  return byLowerCase;
}

/** Every listed zone name (for suggestions). */
export function supportedTimeZones(): string[] {
  return [...table().values()];
}

/** The canonical spelling of a valid zone (any letter case, surrounding spaces ignored), else null. */
export function canonicalTimeZone(input: string): string | null {
  const name = input.trim();
  const listed = table().get(name.toLowerCase());
  if (listed) return listed;
  if (!ZONE_SHAPE.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

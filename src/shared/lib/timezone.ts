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

/** The UTC instant of 00:00 on `now`'s calendar day in the IANA zone `zone` (invalid zone: America/Mexico_City). */
export function storeDayStart(now: Date, zone: string): Date {
  const tz = canonicalTimeZone(zone) ?? 'America/Mexico_City';
  // eslint-disable-next-line i18next/no-literal-string -- Intl option values, not UI copy
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  /** Wall-clock time in `tz` at instant `t`, read as if it were UTC. */
  const wall = (t: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
    return Date.UTC(p['year'] ?? 0, (p['month'] ?? 1) - 1, p['day'] ?? 1, p['hour'] ?? 0, p['minute'] ?? 0, p['second'] ?? 0);
  };
  const w = wall(now.getTime());
  const midnightWall = w - (w % 86_400_000);
  // two passes settle the offset even when the day contains a DST change
  let t = midnightWall - (w - now.getTime());
  t = midnightWall - (wall(t) - t);
  return new Date(t);
}

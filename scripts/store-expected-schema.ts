import { readdirSync } from 'node:fs';

export interface ExpectedSchema {
  maxVersion: string;
  applied: number;
}

/**
 * Build-time schema level of this app: the newest 14-digit migration prefix and
 * the number of migration files. The store server reports the same pair
 * (`store_schema_version`); the till writes only when they are equal.
 */
// Same rule as the pack manifest builder (store-server/pack/build/lib/manifest.mjs): 14 digits, underscore, name, .sql.
// expected.test.ts pins the two against each other.
export function computeExpectedSchema(dir: string): ExpectedSchema {
  const versions = readdirSync(dir)
    .map((f) => /^(\d{14})_.+\.sql$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort();
  return { maxVersion: versions[versions.length - 1] ?? '', applied: versions.length };
}

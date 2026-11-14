export interface SchemaLevel {
  maxVersion: string;
  applied: number;
}

export type SchemaVerdict = 'ok' | 'server-outdated' | 'client-outdated' | 'inconsistent';

const cmp = (a: string | number, b: string | number): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Strict equality (conventions Q14): the till writes only to a server at exactly
 * its own level. Both fields below = server-outdated, both above = client-outdated,
 * anything else (one equal, or mixed) = inconsistent.
 */
export function classify(server: SchemaLevel, bundled: SchemaLevel): SchemaVerdict {
  const v = cmp(server.maxVersion, bundled.maxVersion);
  const a = cmp(server.applied, bundled.applied);
  if (v === 0 && a === 0) return 'ok';
  if (v < 0 && a < 0) return 'server-outdated';
  if (v > 0 && a > 0) return 'client-outdated';
  return 'inconsistent';
}

export type StoreSchemaState =
  | { kind: 'ok' | 'unreachable' | 'updating' }
  | { kind: 'server-outdated' | 'client-outdated' | 'inconsistent' | 'missing'; server?: SchemaLevel };

export type BlockingState = Extract<
  StoreSchemaState,
  { kind: 'server-outdated' | 'client-outdated' | 'inconsistent' | 'missing' }
>;

export function isBlocking(s: StoreSchemaState): s is BlockingState {
  return s.kind !== 'ok' && s.kind !== 'unreachable' && s.kind !== 'updating';
}

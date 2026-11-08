/**
 * _shared/store-header.ts: the receipt header (store name + address) the edge functions print.
 * Settings -> General wins, the BAR_NAME / BAR_ADDRESS secrets are the fallback (Ruling 17),
 * the same source as the provisional slip and the /payments reprint. Never throws: a paid sale
 * must not fail on its header.
 */
// Structural on purpose: a SupabaseClient satisfies it, a test double is three lines.
export interface HeaderReader {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        maybeSingle(): PromiseLike<{ data: { value?: unknown } | null; error?: unknown }>;
      };
    };
  };
}

const nonBlank = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

export async function resolveStoreHeader(
  // unknown, not HeaderReader: checking a full SupabaseClient against the structural type is TS2589 (excessively deep) under `deno compile`'s type check.
  adminClient: unknown,
  // Literal reads only: the local backend pack's build checks every env name statically.
  env: (name: 'BAR_NAME' | 'BAR_ADDRESS') => string | undefined = name =>
    name === 'BAR_NAME' ? Deno.env.get('BAR_NAME') : Deno.env.get('BAR_ADDRESS'),
): Promise<{ storeName: string; barAddress: string }> {
  const admin = adminClient as HeaderReader;
  let general: { storeName?: unknown; address?: unknown } = {};
  try {
    const { data, error } = await admin
      .from('settings')
      .select('value')
      .eq('key', 'general')
      .maybeSingle();
    if (!error && data?.value && typeof data.value === 'object') {
      general = data.value as typeof general;
    }
  } catch {
    // a settings read failure uses the secrets
  }
  return {
    storeName: nonBlank(general.storeName) ?? nonBlank(env('BAR_NAME')) ?? 'Supermarket POS',
    barAddress: nonBlank(general.address) ?? nonBlank(env('BAR_ADDRESS')) ?? '',
  };
}

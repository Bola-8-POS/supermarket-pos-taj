/* eslint-disable i18next/no-literal-string -- the digest algorithm name is a WebCrypto
   identifier, not UI copy. */
import {
  ProcessDirectSaleRequestSchema,
  type ProcessDirectSaleRequest,
} from '@shared/lib/edge-function-contracts';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';

/** JSON with object keys sorted at every level, so the digest ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 (hex) over the canonical request + soldAt + receiptNumber (Ruling 20).
 * The request is first run through ProcessDirectSaleRequestSchema, the form the
 * store persists and `callProcessDirectSale` sends (unknown keys stripped,
 * defaults filled), so a hash computed before storing equals one computed after
 * a reload. A request that does not parse is hashed as given; the store refuses
 * such a record anyway.
 * Catches accidental corruption and casual storage edits; not protection
 * against someone who can recompute the hash.
 */
export async function computeSaleIntegrity(
  body: ProcessDirectSaleRequest,
  soldAt: string,
  receiptNumber: string
): Promise<string> {
  const parsed = ProcessDirectSaleRequestSchema.safeParse(body);
  const normalised = parsed.success ? parsed.data : body;
  const bytes = new TextEncoder().encode(canonical({ body: normalised, soldAt, receiptNumber }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySaleIntegrity(
  sale: Pick<OfflineSale, 'request' | 'soldAt' | 'receiptNumber' | 'integrity'>
): Promise<boolean> {
  return (await computeSaleIntegrity(sale.request, sale.soldAt, sale.receiptNumber)) === sale.integrity;
}

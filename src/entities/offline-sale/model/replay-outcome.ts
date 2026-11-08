import { isUnreachableFailure } from '@shared/lib/connectivity';
import type { ProcessDirectSaleSuccess } from '@shared/lib/edge-function-contracts';
import { formatMoney } from '@shared/lib/format';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import type { Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';
import type { OfflineSaleEvent } from './machine';
/* eslint-disable i18next/no-literal-string -- diagnostics stored on the record and matched
   against the server's own SQL messages, not UI copy. */

type RefusalCode = Extract<OfflineSaleEvent, { type: 'refused' }>['code'];

/** The events a server answer can produce. */
export type ReplayEvent = Extract<
  OfflineSaleEvent,
  { type: 'confirmed' | 'unreachable' | 'refused' | 'failedUnknown' }
>;

export interface ReplayVerdict {
  event: ReplayEvent;
  /** The sale the server recorded, when there is one (confirmed, or refused over a total mismatch). */
  tabId: string | undefined;
}

/**
 * Ruling 10 codes the edge function answers with. They arrive as the prefix of `AppError.details`
 * (`callProcessDirectSale` keeps `<edge code>: <message>` there even when the mapper folds several
 * codes into one `code`), so no server wording is matched. `INVENTORY_NEGATIVE` is the odd one: the
 * RPC wraps it in `DIRECT_SALE_FAILED` and the contract maps it to its own `code`.
 */
const EDGE_REFUSAL_CODES: readonly RefusalCode[] = [
  'AMOUNT_MISMATCH',
  'PRICE_MISMATCH',
  'BELOW_COST_REQUIRES_OVERRIDE',
  'CAJA_CLOSED',
  'SHIFT_NOT_OPEN',
  'FORBIDDEN',
  'IDEMPOTENCY_UNAUTHORIZED',
  'INVALID_ITEMS',
  'WEIGHT_OUT_OF_RANGE',
  'MODIFIER_MISMATCH',
  'INVALID_METHOD',
  'ZERO_TOTAL_SALE',
];

function refusalCodeOf(error: AppError): RefusalCode | undefined {
  if (error.code === 'INVENTORY_NEGATIVE') return 'INVENTORY_NEGATIVE';
  const details = error.details ?? '';
  if (details.startsWith('DIRECT_SALE_FAILED:') && details.includes('INVENTORY_NEGATIVE:')) {
    return 'INVENTORY_NEGATIVE';
  }
  // raised under a manager override so the spent approval rolls back: wrapped like INVENTORY_NEGATIVE
  if (details.startsWith('DIRECT_SALE_FAILED: ZERO_TOTAL_SALE:')) return 'ZERO_TOTAL_SALE';
  return EDGE_REFUSAL_CODES.find(code => details.startsWith(`${code}:`));
}

const cents = (n: number): number => Math.round(n * 100);

/** The total the customer was told (and paid): the stored expected total, else what the tender legs add up to. */
export function offlineSaleTotal({ request }: Pick<OfflineSale, 'request'>): number | undefined {
  if (request.expectedTotal !== undefined) return request.expectedTotal;
  if (request.legs) return request.legs.reduce((sum, leg) => sum + leg.amount, 0);
  return request.amount;
}

/**
 * Maps the server's answer to a stored offline sale to the state machine event
 * (Rulings 6, 9, 10). Pure.
 * - Success: `confirmed` only when the server's receipt total equals the stored total
 *   (Ruling 6); a different total means the sale exists on the server at another price,
 *   which is refused for a manager, never confirmed.
 * - Outcome unknown, not signed in yet, licence guard: `unreachable` (held, not counted).
 * - A Ruling 10 refusal: `refused` at once. Anything else: `failedUnknown` (counted).
 */
export function classifyReplayResult(
  record: Pick<OfflineSale, 'request'>,
  result: Result<ProcessDirectSaleSuccess, AppError>
): ReplayVerdict {
  if (result.ok) {
    const { tabId, receiptData } = result.data;
    if (!receiptData) {
      return {
        event: { type: 'failedUnknown', message: 'The server answered without a receipt' },
        tabId: undefined,
      };
    }
    const expected = offlineSaleTotal(record);
    if (expected === undefined || cents(receiptData.total) !== cents(expected)) {
      const was = expected === undefined ? 'missing' : formatMoney(expected);
      return {
        event: {
          type: 'refused',
          code: 'AMOUNT_MISMATCH',
          message: `Server sale ${tabId} totals ${formatMoney(receiptData.total)}, the customer paid ${was}`,
          tabId,
        },
        tabId,
      };
    }
    return { event: { type: 'confirmed', tabId, receipt: receiptData }, tabId };
  }

  const { error } = result;
  if (
    error.code === 'PAYMENT_OUTCOME_UNKNOWN' ||
    error.code === 'AUTH_REQUIRED' ||
    isUnreachableFailure(error.code, error.message) ||
    // the edge answer's own text (`<edge code>: <message>`) survives in details when the mapper folds the code
    isUnreachableFailure(error.code, error.details ?? '')
  ) {
    return { event: { type: 'unreachable' }, tabId: undefined };
  }
  const message = error.details ?? error.message;
  const code = refusalCodeOf(error);
  return {
    event: code ? { type: 'refused', code, message } : { type: 'failedUnknown', message },
    tabId: undefined,
  };
}

/**
 * MONEY / PERCENT FORMATTING
 *
 * Single locale-aware money/percent formatting utility for this codebase
 * (Phase 28, D-01/D-04/D-06). Reads locale from the Phase 21 i18n singleton
 * via `getCurrentLocale()` — no second locale mechanism.
 *
 * Pure functions only — no async I/O boundary, so this file intentionally
 * does not use the `Result<T>`/`Ok`/`Err` convention from `@shared/lib/result`.
 */

import type { Locale } from '@shared/lib/domain';
import { getCurrentLocale } from '@shared/lib/i18n';

/** D-01: es-MX gets the two-letter-prefixed symbol; en-US gets the bare symbol. */
const CURRENCY_SYMBOL: Record<Locale, string> = {
  'es-MX': 'MX$',
  'en-US': '$',
};

/**
 * Formats a money amount for an explicit locale, bypassing the live i18n
 * session. Exists so locale-parameterized consumers (receipts/PDFs, whose
 * `locale` argument may differ from the current staff session) can format
 * against the transaction's own locale instead of `getCurrentLocale()`.
 *
 * Never passes a currency-style option to `Intl.NumberFormat` — that emits
 * ISO-code output (e.g. "MXN 1,234.50") and can never yield the D-01 symbols.
 *
 * @example formatMoneyIn('es-MX', 12.5) // "MX$12.50"
 * @example formatMoneyIn('en-US', 12.5) // "$12.50"
 * @example formatMoneyIn('en-US', -3) // "-$3.00"
 */
export function formatMoneyIn(
  locale: Locale,
  amount: number,
  options?: { showSign?: boolean }
): string {
  const symbol = CURRENCY_SYMBOL[locale];
  const isNegative = amount < 0;
  const numeric = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));

  const sign = isNegative ? '-' : options?.showSign ? '+' : '';
  return `${sign}${symbol}${numeric}`;
}

/**
 * Formats a money amount using the current staff session's locale
 * (`getCurrentLocale()`). No `locale` parameter on this signature (D-06) —
 * use {@link formatMoneyIn} when the caller needs a specific, non-live locale.
 *
 * @example formatMoney(12.5) // "MX$12.50" (es-MX) or "$12.50" (en-US)
 * @example formatMoney(-3) // "-MX$3.00" / "-$3.00"
 * @example formatMoney(0) // "MX$0.00" / "$0.00"
 * @example formatMoney(12.5, { showSign: true }) // "+MX$12.50" / "+$12.50"
 */
export function formatMoney(amount: number, options?: { showSign?: boolean }): string {
  return formatMoneyIn(getCurrentLocale(), amount, options);
}

/**
 * Formats a number as a locale-formatted percentage string with a '%' suffix.
 * No currency symbol map involved.
 *
 * @example formatPercent(12.5) // "12.5%"
 * @example formatPercent(12.567, { decimals: 2 }) // "12.57%"
 * @example formatPercent(0) // "0%"
 */
export function formatPercent(value: number, options?: { decimals?: number }): string {
  const numeric = new Intl.NumberFormat(getCurrentLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: options?.decimals ?? 1,
  }).format(value);
  return `${numeric}%`;
}

/** Anchored: optional leading minus, one or more digits, optional 1-2 digit fraction. */
const MONEY_INPUT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Parses a user-typed money string into a signed number, or `null` if the
 * input is malformed (D-04).
 *
 * Callers MUST branch on `null` — this function never falls back to `0` or
 * `NaN` for unparseable input, so a missed null check is a compile-visible
 * type error rather than a silently-wrong charge amount.
 *
 * @example parseMoneyInput('12.50') // 12.5
 * @example parseMoneyInput('-5') // -5
 * @example parseMoneyInput('  12.5  ') // 12.5
 * @example parseMoneyInput('12.5.3') // null
 * @example parseMoneyInput('abc') // null
 */
export function parseMoneyInput(input: string): number | null {
  const trimmed = input.trim();
  return MONEY_INPUT_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

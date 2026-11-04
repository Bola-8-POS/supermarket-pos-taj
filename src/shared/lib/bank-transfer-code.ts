/**
 * bank-transfer-code.ts
 *
 * Client-side port of the Luhn reference-code utility, ported verbatim from
 * `.planning/spikes/003-reference-code-design/reference-code.cjs`.
 *
 * This exists purely for instant client-side typo feedback (D-08) before the
 * RPC round-trip. The server-side PL/pgSQL port (Plan 01's
 * `bank_transfer_luhn_check_digit`/`bank_transfer_is_valid_code` functions)
 * remains the sole authority — never trust this module's result as the
 * security boundary.
 */

/** payloadDigits: string of digits, rightmost-first doubling per Luhn. */
export function luhnCheckDigit(payloadDigits: string): number {
  const digits = payloadDigits.split('').reverse();
  let sum = 0;
  digits.forEach((digit, i) => {
    let d = Number(digit);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  });
  return (10 - (sum % 10)) % 10;
}

export function generateCode(randomFn: () => number = Math.random): string {
  let payload = '';
  for (let i = 0; i < 6; i++) payload += String(Math.floor(randomFn() * 10));
  return payload + String(luhnCheckDigit(payload));
}

export function isValidCode(code: string): boolean {
  if (!/^\d{7}$/.test(code)) return false;
  const payload = code.slice(0, 6);
  const check = Number(code.charAt(6));
  return luhnCheckDigit(payload) === check;
}

/**
 * Generate a code guaranteed not to collide with currently-pending codes.
 * (Banxico's field isn't system-unique — the POS must enforce uniqueness
 * only among its own currently-unresolved pending sales.)
 */
export function generateUniqueCode(
  pendingCodes: Set<string>,
  randomFn: () => number = Math.random
): string {
  let code: string;
  let attempts = 0;
  do {
    code = generateCode(randomFn);
    attempts++;
    if (attempts > 1000) {
      throw new Error('pending-code space exhausted — widen payload length');
    }
  } while (pendingCodes.has(code));
  return code;
}

/**
 * Does this text look like a payment card number (PAN)? 13-19 digits once spaces and dashes are
 * removed AND a valid Luhn checksum. The card "reference" field is for the terminal's approval
 * code; a card number typed there would be stored in plain text, printed and sent to the server,
 * so the form and the offline branch refuse it. A 6-digit code, or 16 digits that fail the
 * checksum, is a code and passes.
 */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

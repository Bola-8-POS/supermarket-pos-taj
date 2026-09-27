/**
 * Phone number validation utilities using libphonenumber-js.
 * Focus: MX (+52) and US (+1) per PRD scope.
 * Pure functions — no imports from entities or features.
 */
import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Parses a user-entered phone string and returns E.164 format.
 * Returns null if the input cannot be parsed as a valid MX or US number.
 * Tries MX default first; falls back to US.
 */
export function toE164(raw: string): string | null {
  if (!raw || raw.trim() === '') return null;

  // Try with default country MX for bare numbers (e.g. "55 1234 5678")
  const parsedMX = parsePhoneNumberFromString(raw.trim(), 'MX');
  if (parsedMX?.isValid()) return parsedMX.format('E.164');

  // Retry US if MX parse fails
  const parsedUS = parsePhoneNumberFromString(raw.trim(), 'US');
  if (parsedUS?.isValid()) return parsedUS.format('E.164');

  return null;
}

/**
 * Returns true if the string is already a valid E.164 phone number.
 * E.164 format: + followed by 7-15 digits (e.g. +525512345678)
 */
export function isE164(value: string): boolean {
  return isValidPhoneNumber(value);
}

/**
 * Percent-off price maths. The new price is always computed here, in whole cents, from the CURRENT price the
 * gateway just read; a model never supplies it. Rounding rule: half-up to the cent (99.99 less 15% = 84.9915 -> 84.99).
 * Integer arithmetic only, so there is no float drift. Pure module.
 */
export function priceAfterPercentOff(currentPrice: number, percentOff: number): number | null {
  if (!Number.isFinite(currentPrice) || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) return null;
  const cents = Math.round(currentPrice * 100);
  const after = Math.floor((cents * (100 - percentOff) + 50) / 100);
  return after >= 1 ? after : null;
}

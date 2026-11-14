/**
 * Rounds like Postgres's ROUND(numeric, 2): exact decimal, ties away from zero.
 * Math.round(n * 100) misses half cents in binary (1.005 * 100 = 100.4999...) and
 * rounds negative ties toward +Infinity. toFixed(10) recovers the decimal the
 * float stands for (absorbing arithmetic noise), then the tie is broken on |n|.
 */
export function round2(n: number): number {
  const rounded = Math.round(Number(`${Math.abs(n).toFixed(10)}e2`));
  return (n < 0 ? -rounded : rounded) / 100 + 0; // + 0 turns -0 into 0
}

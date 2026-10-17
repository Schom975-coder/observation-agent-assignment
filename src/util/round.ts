// Integer division rounded half up, for the money and time arithmetic (ARCHITECTURE.md 4.1): every
// quantity is a whole number of hundredths, rounded once, at the end, from integers. Both arguments
// are non-negative integers small enough for exact float arithmetic (well under 2^53 / 2).
export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator <= 0) {
    throw new RangeError(`roundHalfUp needs a non-negative integer over a positive one, got ${numerator}/${denominator}`);
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

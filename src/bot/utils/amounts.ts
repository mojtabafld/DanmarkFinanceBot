/**
 * Amounts are stored as floats, so "nothing left on this ad" has to be a tolerance
 * rather than an exact zero: repeated partial fills accumulate binary rounding error
 * and a strict `=== 0` check would leave ads stuck open with a residue like 1e-13.
 */
export const AMOUNT_EPSILON = 0.0001;

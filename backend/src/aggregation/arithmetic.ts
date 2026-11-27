// Exact integer arithmetic of the rebuild (ADR 0035 point 3, M3-T3). Weights
// are integers (L / n), sums are integers, and every addition is checked: an
// unsafe integer fails the whole run instead of losing precision. Mean and
// spread are computed from integers in BigInt, rounded only at the end.
import { DAILY_CAP, MAX_HALF_POINTS, MIN_HALF_POINTS, WEIGHT_DENOMINATOR } from './config.ts';

/** A sum left the safe integer range, or an input was not an integer in range. The run must fail and write nothing. */
export class AggregationArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AggregationArithmeticError';
  }
}

function assertSafe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new AggregationArithmeticError(`${what} is not a safe integer`);
  return value;
}

/** `a + b`, both non-negative safe integers, result asserted safe. */
export function safeAdd(a: number, b: number, what = 'sum'): number {
  assertSafe(a, what);
  assertSafe(b, what);
  if (a < 0 || b < 0) throw new AggregationArithmeticError(`${what} must not be negative`);
  return assertSafe(a + b, what);
}

/** `a x b`, both non-negative safe integers, result asserted safe. */
export function safeMul(a: number, b: number, what = 'product'): number {
  assertSafe(a, what);
  assertSafe(b, what);
  if (a < 0 || b < 0) throw new AggregationArithmeticError(`${what} must not be negative`);
  return assertSafe(a * b, what);
}

/** `L / n` for a group of n counted cups, n from 1 to the daily cap. Any other n throws. Never leaves a remainder. */
export function weightOf(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > DAILY_CAP) throw new AggregationArithmeticError('group size is outside 1 to the daily cap');
  const weight = WEIGHT_DENOMINATOR / n;
  if (!Number.isInteger(weight)) throw new AggregationArithmeticError('weight denominator is not divisible by the group size');
  return weight;
}

/** The three integers one criterion keeps. */
export interface WeightedTotals {
  /** Sum of the weights of the counted cups. */
  readonly weightedCount: number;
  /** Sum of weight x half-points. */
  readonly sum: number;
  /** Sum of weight x half-points squared. */
  readonly sumOfSquares: number;
}

/** Adds weighted half-point scores and asserts every sum is a safe integer after each addition. */
export class WeightedAccumulator {
  #weightedCount: number;
  #sum: number;
  #sumOfSquares: number;

  constructor(initial?: WeightedTotals) {
    this.#weightedCount = assertSafe(initial?.weightedCount ?? 0, 'weighted count');
    this.#sum = assertSafe(initial?.sum ?? 0, 'sum');
    this.#sumOfSquares = assertSafe(initial?.sumOfSquares ?? 0, 'sum of squares');
  }

  /** One counted cup: `weight` from `weightOf(n)`, `halfPoints` an integer from 2 to 20. */
  add(weight: number, halfPoints: number): void {
    assertWeight(weight);
    if (!Number.isInteger(halfPoints) || halfPoints < MIN_HALF_POINTS || halfPoints > MAX_HALF_POINTS) throw new AggregationArithmeticError('score is outside the half-point range');
    const weighted = safeMul(weight, halfPoints, 'weighted score');
    const weightedSquare = safeMul(weighted, halfPoints, 'weighted square');
    this.merge({ weightedCount: weight, sum: weighted, sumOfSquares: weightedSquare });
  }

  /** Folds partial totals in (the same checked additions). All three are checked before any is kept. */
  merge(other: WeightedTotals): void {
    const weightedCount = safeAdd(this.#weightedCount, other.weightedCount, 'weighted count');
    const sum = safeAdd(this.#sum, other.sum, 'sum');
    const sumOfSquares = safeAdd(this.#sumOfSquares, other.sumOfSquares, 'sum of squares');
    this.#weightedCount = weightedCount;
    this.#sum = sum;
    this.#sumOfSquares = sumOfSquares;
  }

  get totals(): WeightedTotals {
    return { weightedCount: this.#weightedCount, sum: this.#sum, sumOfSquares: this.#sumOfSquares };
  }
}

/** A weighted count (events, not scores): `count += weight`, asserted safe. */
export function addWeight(count: number, weight: number, what = 'weighted count'): number {
  assertWeight(weight);
  return safeAdd(count, weight, what);
}

// ---- reading: mean and spread, from integers, in BigInt ----

function checkTotals(totals: WeightedTotals): { w: bigint; s: bigint; ss: bigint } {
  const { weightedCount, sum, sumOfSquares } = totals;
  for (const value of [weightedCount, sum, sumOfSquares]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AggregationArithmeticError('totals must be non-negative safe integers');
  }
  if (weightedCount === 0) throw new AggregationArithmeticError('no weight');
  return { w: BigInt(weightedCount), s: BigInt(sum), ss: BigInt(sumOfSquares) };
}

/** Largest integer r with r x r <= n (n a non-negative BigInt). Newton iteration on BigInt: exact for any size. */
export function integerSquareRoot(n: bigint): bigint {
  if (n < 0n) throw new AggregationArithmeticError('square root of a negative number');
  if (n < 2n) return n;
  // Start at a power of two above the root, so the sequence decreases monotonically to the floor.
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/** A weight that `weightOf` can produce: L / n for n from 1 to the daily cap. */
function assertWeight(weight: number): void {
  if (!Number.isInteger(weight) || weight < 1 || WEIGHT_DENOMINATOR % weight !== 0 || WEIGHT_DENOMINATOR / weight > DAILY_CAP) {
    throw new AggregationArithmeticError('weight is not L / n for a group size n from 1 to the daily cap');
  }
}

/** Variance in half-points squared as the exact fraction `(W x SS - S^2) / W^2`. Never negative. */
export function varianceHalfPointsSquared(totals: WeightedTotals): { numerator: bigint; denominator: bigint } {
  const { w, s, ss } = checkTotals(totals);
  const numerator = w * ss - s * s;
  if (numerator < 0n) throw new AggregationArithmeticError('sum of squares is below the square of the sum');
  return { numerator, denominator: w * w };
}

/** Mean in points (0 to 10 scale) in tenths of a point, `S / (2W)` x 10 rounded half up. Exact integer arithmetic. */
export function meanPointsTenths(totals: WeightedTotals): number {
  const { w, s } = checkTotals(totals);
  return Number((10n * s + w) / (2n * w));
}

/** Spread in points (standard deviation on the 0 to 10 scale) in tenths of a point, rounded half up at the end only. */
export function spreadPointsTenths(totals: WeightedTotals): number {
  const { numerator, denominator } = varianceHalfPointsSquared(totals);
  // tenths = round(10 x sqrt(var) / 2) = round(sqrt(25 x var)); r = the largest integer
  // with (2r - 1)^2 x den <= 100 x num, which is r = (isqrt(floor(100 x num / den)) + 1) / 2.
  const root = integerSquareRoot((100n * numerator) / denominator);
  return Number((root + 1n) >> 1n);
}

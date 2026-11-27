import { describe, expect, it } from 'vitest';
import {
  AggregationArithmeticError,
  WeightedAccumulator,
  addWeight,
  integerSquareRoot,
  meanPointsTenths,
  safeAdd,
  safeMul,
  spreadPointsTenths,
  varianceHalfPointsSquared,
  weightOf,
} from '../../src/aggregation/arithmetic.ts';
import { DAILY_CAP, MAX_EXACT_CUPS, MAX_HALF_POINTS, MAX_SUM_OF_SQUARES_PER_CUP, MAX_SUM_PER_CUP, MIN_HALF_POINTS, WEIGHT_DENOMINATOR } from '../../src/aggregation/config.ts';

const MAX = Number.MAX_SAFE_INTEGER;

describe('weightOf', () => {
  it.each(Array.from({ length: DAILY_CAP }, (_, i) => i + 1))('n = %i: n x weight is exactly L, with no remainder', (n) => {
    const weight = weightOf(n);
    expect(Number.isInteger(weight)).toBe(true);
    expect(WEIGHT_DENOMINATOR % n).toBe(0);
    expect(n * weight).toBe(WEIGHT_DENOMINATOR);
  });

  it.each([0, -1, DAILY_CAP + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws for n = %s', (n) => {
    expect(() => weightOf(n)).toThrow(AggregationArithmeticError);
  });
});

describe('safeAdd and safeMul', () => {
  it('add the largest safe sum and fail one above it', () => {
    expect(safeAdd(MAX - 1, 1)).toBe(MAX);
    expect(() => safeAdd(MAX, 1)).toThrow(AggregationArithmeticError);
    expect(() => safeAdd(MAX, MAX)).toThrow(AggregationArithmeticError);
  });

  it('refuse negative, fractional and unsafe operands', () => {
    expect(() => safeAdd(-1, 2)).toThrow(AggregationArithmeticError);
    expect(() => safeAdd(1.5, 2)).toThrow(AggregationArithmeticError);
    expect(() => safeAdd(MAX + 2, 0)).toThrow(AggregationArithmeticError);
    expect(() => safeMul(-1, 2)).toThrow(AggregationArithmeticError);
  });

  it('multiply up to the bound and fail above it', () => {
    expect(safeMul(MAX_EXACT_CUPS, MAX_SUM_OF_SQUARES_PER_CUP)).toBeLessThanOrEqual(MAX);
    expect(() => safeMul(MAX_EXACT_CUPS + 1, MAX_SUM_OF_SQUARES_PER_CUP)).toThrow(AggregationArithmeticError);
  });
});

describe('WeightedAccumulator', () => {
  it('one cup of 20 half-points alone in its group adds the per-cup bounds 50,400 and 1,008,000', () => {
    const acc = new WeightedAccumulator();
    acc.add(weightOf(1), MAX_HALF_POINTS);
    expect(acc.totals).toEqual({ weightedCount: 2520, sum: 50_400, sumOfSquares: 1_008_000 });
    expect(acc.totals.sum).toBe(MAX_SUM_PER_CUP);
    expect(acc.totals.sumOfSquares).toBe(MAX_SUM_OF_SQUARES_PER_CUP);
  });

  it('three cups of one group weigh one vote: 3 x 840 = 2520', () => {
    const acc = new WeightedAccumulator();
    for (const hp of [4, 8, 20]) acc.add(weightOf(3), hp);
    expect(acc.totals).toEqual({ weightedCount: 2520, sum: 840 * 32, sumOfSquares: 840 * (16 + 64 + 400) });
  });

  it('the stated test size (200 users x 10 cups of 20 half-points) stays exact with room to spare', () => {
    const acc = new WeightedAccumulator();
    for (let user = 0; user < 200; user += 1) {
      for (let cup = 0; cup < DAILY_CAP; cup += 1) acc.add(weightOf(DAILY_CAP), MAX_HALF_POINTS);
    }
    expect(acc.totals.weightedCount).toBe(200 * WEIGHT_DENOMINATOR);
    expect(acc.totals.sum).toBe(200 * MAX_SUM_PER_CUP);
    expect(acc.totals.sumOfSquares).toBe(200 * MAX_SUM_OF_SQUARES_PER_CUP);
    expect(acc.totals.sumOfSquares).toBeLessThan(MAX / 1e6);
  });

  it('reaches the 2^53 limit of the sum of squares exactly and fails closed one cup later', () => {
    const room = MAX - MAX_EXACT_CUPS * MAX_SUM_OF_SQUARES_PER_CUP;
    expect(room).toBeLessThan(MAX_SUM_OF_SQUARES_PER_CUP);
    const acc = new WeightedAccumulator({ weightedCount: 0, sum: 0, sumOfSquares: MAX_EXACT_CUPS * MAX_SUM_OF_SQUARES_PER_CUP });
    expect(() => { acc.add(weightOf(1), MAX_HALF_POINTS); }).toThrow(AggregationArithmeticError);
  });

  it('a forced overflow of the sum fails closed and leaves the totals untouched', () => {
    const start = { weightedCount: 10, sum: MAX - 5, sumOfSquares: 10 };
    const acc = new WeightedAccumulator(start);
    expect(() => { acc.add(weightOf(1), MIN_HALF_POINTS); }).toThrow(AggregationArithmeticError);
    expect(acc.totals).toEqual(start);
  });

  it('a forced overflow of the weighted count fails closed', () => {
    const acc = new WeightedAccumulator({ weightedCount: MAX - 1, sum: 0, sumOfSquares: 0 });
    expect(() => { acc.add(weightOf(1), MIN_HALF_POINTS); }).toThrow(AggregationArithmeticError);
  });

  it('merge fails closed on overflow too', () => {
    const acc = new WeightedAccumulator({ weightedCount: 0, sum: 0, sumOfSquares: MAX });
    expect(() => { acc.merge({ weightedCount: 0, sum: 0, sumOfSquares: 1 }); }).toThrow(AggregationArithmeticError);
  });

  it('refuses an unsafe starting state', () => {
    expect(() => new WeightedAccumulator({ weightedCount: 0, sum: MAX + 2, sumOfSquares: 0 })).toThrow(AggregationArithmeticError);
  });

  it.each([0, 1, 21, 4.5, Number.NaN])('refuses the score %s (half-points are integers 2 to 20)', (hp) => {
    expect(() => { new WeightedAccumulator().add(weightOf(1), hp); }).toThrow(AggregationArithmeticError);
  });

  it.each([0, -1, 1, 7, 2519, WEIGHT_DENOMINATOR + 1, 1.5])('refuses the weight %s', (weight) => {
    expect(() => { new WeightedAccumulator().add(weight, 10); }).toThrow(AggregationArithmeticError);
  });

  it('addWeight adds weights and fails closed', () => {
    expect(addWeight(0, weightOf(4))).toBe(630);
    expect(() => addWeight(MAX, weightOf(1))).toThrow(AggregationArithmeticError);
    expect(() => addWeight(0, 0)).toThrow(AggregationArithmeticError);
    for (const bad of [1, 7, 2519]) expect(() => addWeight(0, bad)).toThrow(AggregationArithmeticError);
  });
});

/** Small seeded generator (mulberry32) so the property test is repeatable. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('order does not matter', () => {
  it('any order of the same weighted values gives the same totals (200 shuffles)', () => {
    const next = random(20261127);
    const cups: { n: number; hp: number }[] = [];
    for (let i = 0; i < 300; i += 1) {
      cups.push({ n: 1 + Math.floor(next() * DAILY_CAP), hp: MIN_HALF_POINTS + Math.floor(next() * (MAX_HALF_POINTS - MIN_HALF_POINTS + 1)) });
    }
    const total = (list: typeof cups): unknown => {
      const acc = new WeightedAccumulator();
      for (const { n, hp } of list) acc.add(weightOf(n), hp);
      return acc.totals;
    };
    const expected = total(cups);
    for (let round = 0; round < 200; round += 1) {
      const shuffled = [...cups];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = shuffled[i];
        const b = shuffled[j];
        if (a === undefined || b === undefined) throw new Error('unreachable');
        shuffled[i] = b;
        shuffled[j] = a;
      }
      expect(total(shuffled)).toEqual(expected);
    }
  });

  it('merging partial totals in either order gives the same totals', () => {
    const a = { weightedCount: 2520, sum: 25_200, sumOfSquares: 252_000 };
    const b = { weightedCount: 1260, sum: 5040, sumOfSquares: 20_160 };
    const ab = new WeightedAccumulator(a);
    ab.merge(b);
    const ba = new WeightedAccumulator(b);
    ba.merge(a);
    expect(ab.totals).toEqual(ba.totals);
  });
});

describe('integerSquareRoot', () => {
  it.each([
    [0n, 0n],
    [1n, 1n],
    [2n, 1n],
    [3n, 1n],
    [4n, 2n],
    [99n, 9n],
    [100n, 10n],
    [(2n ** 53n) ** 2n, 2n ** 53n],
    [(2n ** 53n) ** 2n - 1n, 2n ** 53n - 1n],
  ])('isqrt(%s) = %s', (n, root) => {
    expect(integerSquareRoot(n)).toBe(root);
  });

  it('is exact and quick for a very large input', () => {
    const root = 3n ** 120n;
    const start = performance.now();
    expect(integerSquareRoot(root * root)).toBe(root);
    expect(integerSquareRoot(root * root - 1n)).toBe(root - 1n);
    expect(integerSquareRoot(root * root + 2n * root)).toBe(root);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('throws for a negative number', () => {
    expect(() => integerSquareRoot(-1n)).toThrow(AggregationArithmeticError);
  });
});

function totalsOf(cups: readonly { n: number; hp: number }[]): { weightedCount: number; sum: number; sumOfSquares: number } {
  const acc = new WeightedAccumulator();
  for (const { n, hp } of cups) acc.add(weightOf(n), hp);
  return acc.totals;
}

describe('mean and spread from integers', () => {
  it('two single-cup votes of 5 and 10 points: mean 7.5, spread 2.5 (exact)', () => {
    const totals = totalsOf([{ n: 1, hp: 10 }, { n: 1, hp: 20 }]);
    expect(varianceHalfPointsSquared(totals)).toEqual({ numerator: 5040n * 1_260_000n - 75_600n ** 2n, denominator: 5040n ** 2n });
    expect(meanPointsTenths(totals)).toBe(75);
    expect(spreadPointsTenths(totals)).toBe(25);
  });

  it('identical scores have spread exactly 0, not a float residue', () => {
    expect(spreadPointsTenths(totalsOf(Array.from({ length: 7 }, () => ({ n: 1, hp: 17 }))))).toBe(0);
    expect(meanPointsTenths(totalsOf([{ n: 1, hp: 17 }]))).toBe(85);
  });

  it('rounds the exact tie half up: 2 and 3 half-points at equal weight give mean 12.5 tenths, so 13', () => {
    // mean 2.5 hp = 1.25 points = 12.5 tenths exactly
    expect(meanPointsTenths(totalsOf([{ n: 1, hp: 2 }, { n: 1, hp: 3 }]))).toBe(13);
    // spread: sd 0.5 hp = 0.25 points = 2.5 tenths exactly, rounds to 3
    expect(spreadPointsTenths(totalsOf([{ n: 1, hp: 2 }, { n: 1, hp: 3 }]))).toBe(3);
  });

  it('rounds half up only at the end', () => {
    // 2, 2, 3 half-points: mean 7/3 hp = 1.1667 points -> 12 tenths; spread 0.2357 points -> 2 tenths.
    const totals = totalsOf([{ n: 1, hp: 2 }, { n: 1, hp: 2 }, { n: 1, hp: 3 }]);
    expect(meanPointsTenths(totals)).toBe(12);
    expect(spreadPointsTenths(totals)).toBe(2);
    // 3 and 4 half-points: mean 1.75 points -> 17.5 tenths rounds up to 18.
    expect(meanPointsTenths(totalsOf([{ n: 1, hp: 3 }, { n: 1, hp: 4 }]))).toBe(18);
  });

  it('stays exact where W x SS passes 2^53 (the float form would cancel)', () => {
    // 5,000 votes of 10 half-points and 5,000 of 20: mean 15, spread 5 half-points = 2.5 points.
    const acc = new WeightedAccumulator();
    for (let i = 0; i < 5000; i += 1) {
      acc.add(weightOf(1), 10);
      acc.add(weightOf(1), 20);
    }
    const totals = acc.totals;
    expect(BigInt(totals.weightedCount) * BigInt(totals.sumOfSquares)).toBeGreaterThan(2n ** 53n);
    expect(Number.isSafeInteger(totals.weightedCount * totals.sumOfSquares)).toBe(false);
    expect(meanPointsTenths(totals)).toBe(75);
    expect(spreadPointsTenths(totals)).toBe(25);
    expect(varianceHalfPointsSquared(totals).numerator * 1n).toBe(25n * BigInt(totals.weightedCount) ** 2n);
  });

  it('a hand-picked set whose float mean differs in the last digits has an exact rational mean', () => {
    // Weights 840 (n=3) and 2520 (n=1): sum / weighted count is 3 x 840 x 3 ... computed exactly as integers.
    const totals = totalsOf([{ n: 3, hp: 7 }, { n: 3, hp: 7 }, { n: 3, hp: 8 }, { n: 1, hp: 9 }]);
    expect(totals.weightedCount).toBe(5040);
    expect(totals.sum).toBe(840 * 22 + 2520 * 9);
    expect(varianceHalfPointsSquared(totals).denominator).toBe(5040n ** 2n);
  });

  it('refuses totals with no weight or unsafe values', () => {
    expect(() => meanPointsTenths({ weightedCount: 0, sum: 0, sumOfSquares: 0 })).toThrow(AggregationArithmeticError);
    expect(() => spreadPointsTenths({ weightedCount: 1, sum: MAX + 2, sumOfSquares: 1 })).toThrow(AggregationArithmeticError);
    expect(() => varianceHalfPointsSquared({ weightedCount: 1, sum: 5, sumOfSquares: 1 })).toThrow(AggregationArithmeticError);
  });
});

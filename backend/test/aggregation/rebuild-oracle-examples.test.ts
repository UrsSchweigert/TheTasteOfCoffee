// Explicit examples of M3-T6 that are not properties: the three rules for which "a rejected
// brew leaves the output equal to a history without it" does NOT hold (bag dose, straight-lining,
// daily cap), and the 4-versus-5 rater boundaries of the method and price band lists. Each
// expected number is written out; the oracle is run alongside as a second opinion.
import { describe, expect, it } from 'vitest';
import { WEIGHT_DENOMINATOR } from '../../src/aggregation/config.ts';
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import type { RebuildInput } from '../../src/aggregation/rebuild/types.ts';
import type { Method, PriceBand } from '../../src/generated/contract.ts';
import { brew, DAY, entry, input, MIN, rated, scores, T0 } from './rebuild-fixtures.ts';
import { facetKey, normalised } from './support/campaign.ts';
import { oracle } from './support/oracle.ts';

const L = WEIGHT_DENOMINATOR;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const bean1 = (history: RebuildInput) => must(rebuild(history).aggregates.find((i) => i.bean_id === 'bean1' && i.method === undefined));

describe('bag dose: a rejected brew still holds a place in the burst window (rule 5 runs before rule 6)', () => {
  // One user, one bag of 250 g: the limit is 250 x 10 x 110 / 100 = 2,750 dg.
  // Days 1 to 3: one cup each with 900 dg (running 900, 1,800, 2,700: all fit), o = 7, h = 14.
  // Day 4, within one minute (10 s apart), six brews S1..S6. S1 has 900 dg: 2,700 + 900 = 3,600 > 2,750, so rule 6 rejects it.
  //   Rule 5 comes first and sees all six: the earliest 5 (S1..S5) count, S6 is a burst reject. Rule 6 then rejects S1.
  //   Counted on day 4: S2..S5.
  // The same history without S1: S2..S6 are five brews, so none is a burst reject and all five count.
  const day4 = T0 + 3 * DAY;
  const prior = [0, 1, 2].map((d) => brew({ id: `p${String(d)}`, at: T0 + d * DAY, parameters: { dose_dg: 900 }, rating: rated(7) }));
  const six = (withFirst: boolean): RebuildInput => {
    const overall = [10, 8, 6, 8, 6, 10]; // S1 .. S6
    const burst = overall.map((o, i) => brew({ id: `s${String(i + 1)}`, at: day4 + i * 10_000, ...(i === 0 ? { parameters: { dose_dg: 900 } } : {}), rating: rated(o) }));
    return input({ shelfEntries: [entry({ bagSize: 'g_250' })], brews: [...prior, ...(withFirst ? burst : burst.slice(1))] });
  };

  it('with S1: S1 is bag_dose_exceeded, S6 is burst, S2..S5 count at 630 each', () => {
    const history = six(true);
    const result = rebuild(history);
    expect(result.counts.reasons).toMatchObject({ bag_dose_exceeded: 1, burst: 1 });
    expect(result.counts.brews_counted).toBe(3 + 4);
    // Prior days: 3 votes of h 14: sum 3 x 2,520 x 14 = 105,840. Day 4: n = 4, w = 630: h = 16, 12, 16, 12 -> 630 x 56 = 35,280.
    expect(bean1(history).criteria.overall).toEqual({ weighted_count: 4 * L, sum: 105_840 + 35_280, sum_of_squares: 3 * L * 196 + 630 * (256 + 144 + 256 + 144) });
    expect(normalised(result)).toEqual(normalised(oracle(history)));
  });

  it('without S1 the output is different: S2..S6 count at 504 each, so the property does not hold for this rule', () => {
    const history = six(false);
    const result = rebuild(history);
    expect(result.counts.reasons).toMatchObject({ bag_dose_exceeded: 0, burst: 0 });
    expect(result.counts.brews_counted).toBe(3 + 5);
    // Day 4: n = 5, w = 504: h = 16, 12, 16, 12, 20 -> 504 x 76 = 38,304.
    expect(bean1(history).criteria.overall.sum).toBe(105_840 + 38_304);
    expect(bean1(history).criteria.overall.sum).not.toBe(bean1(six(true)).criteria.overall.sum);
    expect(normalised(result)).toEqual(normalised(oracle(history)));
  });
});

describe('straight-lining judges the whole history of a user (rule 7)', () => {
  const sameScores = (day: number): ReturnType<typeof brew> => brew({ id: `x${String(day).padStart(2, '0')}`, at: T0 - day * DAY, rating: { scores: scores(7, 7, 7, 7, 7, 7, 7, 7) } });
  const days = (n: number) => Array.from({ length: n }, (_, d) => sameScores(d));

  it('10 rated brews with the same value in every score: all 10 are rejected and no item exists', () => {
    const history = input({ shelfEntries: [entry()], brews: days(10) });
    const result = rebuild(history);
    expect(result.aggregates).toEqual([]);
    expect(result.counts).toMatchObject({ brews_seen: 10, brews_counted: 0 });
    expect(result.counts.reasons.straight_lining).toBe(10);
    expect(normalised(result)).toEqual(normalised(oracle(history)));
  });

  it('removing one of the ten leaves 9, which are judged by nobody and all count: the output is not that of "the rejected brew removed from nothing"', () => {
    const history = input({ shelfEntries: [entry()], brews: days(9) });
    const result = rebuild(history);
    // 9 votes of h 14: weighted count 9 x 2,520 = 22,680, sum 22,680 x 14 = 317,520, squares 22,680 x 196 = 4,445,280.
    expect(bean1(history).criteria.overall).toEqual({ weighted_count: 22_680, sum: 317_520, sum_of_squares: 4_445_280 });
    expect(result.counts.reasons.straight_lining).toBe(0);
    expect(normalised(result)).toEqual(normalised(oracle(history)));
  });

  it('10 brews of which one score differs are not straight-lining, and an unrated brew does not count towards the 10', () => {
    const different = brew({ id: 'x99', at: T0 - 20 * DAY, rating: { scores: scores(7, 7, 7, 7, 7, 7, 7, 7.5) } });
    const varied = input({ shelfEntries: [entry()], brews: [...days(9), different] });
    expect(rebuild(varied).counts).toMatchObject({ brews_counted: 10 });
    const unrated = input({ shelfEntries: [entry()], brews: [...days(9), brew({ id: 'x98', at: T0 - 20 * DAY, rating: null })] });
    expect(rebuild(unrated).counts).toMatchObject({ brews_counted: 9 });
    expect(rebuild(unrated).counts.reasons).toMatchObject({ straight_lining: 0, unrated: 1 });
    expect(normalised(rebuild(varied))).toEqual(normalised(oracle(varied)));
  });
});

describe('daily cap: a cap reject still used the bag in rule 6 (rule 6 runs before rule 8)', () => {
  // One bag of 250 g (limit 2,750 dg). Day 1: 11 cups 10 minutes apart; cups 1..10 have 200 dg (running 2,000), cup 11 has 700 dg
  // (2,700 fits, so rule 6 keeps it); rule 8 then rejects cup 11 (the 11th of the day). Day 2: one cup of 200 dg: 2,700 + 200 = 2,900 > 2,750:
  // bag_dose_exceeded. Without cup 11 the running dose is 2,000 + 200 = 2,200 and the day-2 cup counts.
  const history = (withEleventh: boolean): RebuildInput => {
    const cups = Array.from({ length: withEleventh ? 11 : 10 }, (_, i) => brew({ id: `c${String(i).padStart(2, '0')}`, at: T0 + i * 10 * MIN, parameters: { dose_dg: i === 10 ? 700 : 200 }, rating: rated(8) }));
    return input({ shelfEntries: [entry({ bagSize: 'g_250' })], brews: [...cups, brew({ id: 'd2', at: T0 + DAY, parameters: { dose_dg: 200 }, rating: rated(8) })] });
  };

  it('with the 11th cup: the 11th is daily_cap_exceeded and the day-2 cup is bag_dose_exceeded; one vote only', () => {
    const result = rebuild(history(true));
    expect(result.counts.reasons).toMatchObject({ daily_cap_exceeded: 1, bag_dose_exceeded: 1 });
    expect(result.counts.brews_counted).toBe(10);
    expect(bean1(history(true)).criteria.overall.weighted_count).toBe(L);
    expect(normalised(result)).toEqual(normalised(oracle(history(true))));
  });

  it('without the 11th cup the day-2 cup counts: two votes, so the output differs and the property does not hold for this rule', () => {
    const result = rebuild(history(false));
    expect(result.counts.reasons).toMatchObject({ daily_cap_exceeded: 0, bag_dose_exceeded: 0 });
    expect(result.counts.brews_counted).toBe(11);
    expect(bean1(history(false)).criteria.overall.weighted_count).toBe(2 * L);
    expect(normalised(result)).toEqual(normalised(oracle(history(false))));
  });
});

describe('the 4-versus-5 rater boundary of the method and price band lists', () => {
  interface Rater {
    readonly user: string;
    /** One cup per method listed, on the same day. */
    readonly methods: readonly Method[];
    /** The band of the user's shelf entry, or none. */
    readonly band?: PriceBand;
    /** A second shelf entry in another band, with one more cup. */
    readonly second?: PriceBand;
  }

  function crowd(raters: readonly Rater[]): RebuildInput {
    const shelfEntries = raters.flatMap((r) => [
      entry({ user: r.user, id: 'e1', ...(r.band ? { priceBand: r.band } : {}) }),
      ...(r.second ? [entry({ user: r.user, id: 'e2', priceBand: r.second })] : []),
    ]);
    const brews = raters.flatMap((r, i) => [
      ...r.methods.map((method, j) => brew({ user: r.user, id: `${r.user}m${String(j)}`, at: T0 + i * MIN + j * 10_000, method, rating: rated(6 + (i % 4)) })),
      ...(r.second ? [brew({ user: r.user, id: `${r.user}s`, at: T0 + i * MIN + 30_000, entry: 'e2', rating: rated(5) })] : []),
    ]);
    return input({ shelfEntries, brews });
  }

  const lists = (history: RebuildInput): string[] => {
    const result = rebuild(history);
    expect(normalised(result)).toEqual(normalised(oracle(history)));
    return normalised(result).rankings.map((r) => facetKey(r.facet));
  };
  const users = (n: number): string[] => Array.from({ length: n }, (_, i) => `u${String(i + 1)}`);

  it('method: 4 + 1 gives no method list, 5 + 0 gives one, 3 + 2 gives none; a user with both methods counts in both', () => {
    const split = (v60: number, espresso: number): RebuildInput => crowd([...users(v60).map((user) => ({ user, methods: ['v60' as const] })), ...users(v60 + espresso).slice(v60).map((user) => ({ user, methods: ['espresso' as const] }))]);
    expect(lists(split(4, 1))).toEqual(['all']);
    expect(lists(split(3, 2))).toEqual(['all']);
    expect(lists(split(5, 0))).toEqual(['all', 'method/v60']);
    // 4 users with v60 only, a fifth with both: v60 has 5 raters, espresso has 1.
    const both = crowd([...users(4).map((user) => ({ user, methods: ['v60' as const] })), { user: 'u5', methods: ['v60' as const, 'espresso' as const] }]);
    expect(lists(both)).toEqual(['all', 'method/v60']);
    // All five raters of the bean exist in every case, so the aggregate item is there at 4 as well.
    expect(rebuild(split(4, 1)).aggregates.filter((i) => i.method === undefined).map((i) => i.raters)).toEqual([5]);
  });

  it('price band: 4 raters in a band give no band list, 5 do; a fifth rater in another band or without a band does not help', () => {
    const inBand = (n: number, band: PriceBand): Rater[] => users(n).map((user) => ({ user, methods: ['v60' as const], band }));
    expect(lists(crowd([...inBand(4, 'from_15_to_30'), { user: 'u5', methods: ['v60'], band: 'from_30_to_45' }]))).toEqual(['all', 'method/v60']);
    expect(lists(crowd([...inBand(4, 'from_15_to_30'), { user: 'u5', methods: ['v60'] }]))).toEqual(['all', 'method/v60']);
    expect(lists(crowd(inBand(5, 'from_15_to_30')))).toEqual(['all', 'method/v60', 'price_band/from_15_to_30']);
    // Six raters, 5 in one band and 1 in another: only the band with 5 has a list.
    expect(lists(crowd([...inBand(5, 'from_15_to_30'), { user: 'u6', methods: ['v60'], band: 'from_45_to_60' }]))).toEqual(['all', 'method/v60', 'price_band/from_15_to_30']);
    // A user who also bought the bean in a second band counts as a rater of both bands: 4 + u5 in band X with a second entry in Y gives X 5 raters, Y 1.
    const second = crowd([...inBand(4, 'from_15_to_30'), { user: 'u5', methods: ['v60'], band: 'from_15_to_30', second: 'from_30_to_45' }]);
    expect(lists(second)).toEqual(['all', 'method/v60', 'price_band/from_15_to_30']);
    // And with the second band held by 5 users, both bands are listed: 5 users in X, of whom all 5 also have a Y entry.
    const both = crowd(users(5).map((user) => ({ user, methods: ['v60' as const], band: 'from_15_to_30' as const, second: 'from_30_to_45' as const })));
    expect(lists(both)).toEqual(['all', 'method/v60', 'price_band/from_15_to_30', 'price_band/from_30_to_45']);
  });
});

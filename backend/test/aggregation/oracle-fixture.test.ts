// The hand-computed oracle fixture against rebuild() and against the oracle (M3-T6).
// The expected numbers are in oracle-fixture.ts with their arithmetic; this file only compares.
import { describe, expect, it } from 'vitest';
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import { expectedAggregates, expectedCounts, expectedRankings, fixtureInput } from './oracle-fixture.ts';
import { facetKey, normalised } from './support/campaign.ts';
import { shuffledHistory } from './support/histories.ts';
import { oracle } from './support/oracle.ts';
import { Rng } from './support/rng.ts';

const result = rebuild(fixtureInput);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

describe('oracle fixture: 8 users, 4 beans, 2 methods, 39 brews', () => {
  it('has the size the task asks for', () => {
    expect(new Set(fixtureInput.brews.map((b) => b.userId)).size).toBe(8);
    expect(new Set(fixtureInput.shelfEntries.map((e) => e.entry.values.bean_id)).size).toBe(4);
    expect(new Set(fixtureInput.brews.map((b) => b.brew.values.parameters.method))).toEqual(new Set(['v60', 'espresso']));
    expect(fixtureInput.brews).toHaveLength(39);
  });

  it('gives exactly the hand-computed items, item by item', () => {
    expect(result.aggregates).toHaveLength(expectedAggregates.length);
    expectedAggregates.forEach((expected, i) => {
      const actual = must(result.aggregates[i]);
      expect(actual, `${expected.bean_id} ${expected.method ?? 'all'}`).toEqual(expected);
    });
  });

  it('gives exactly the hand-computed rankings, list by list', () => {
    const actual = normalised(result).rankings;
    expect(actual.map((r) => facetKey(r.facet))).toEqual(expectedRankings.map((r) => facetKey(r.facet)));
    expectedRankings.forEach((expected, i) => {
      expect(must(actual[i]), facetKey(expected.facet)).toEqual(expected);
    });
  });

  it('gives exactly the hand-computed counts, every reason id included', () => {
    expect(result.counts).toEqual(expectedCounts);
  });

  it('gives the whole expected output and nothing else', () => {
    expect(normalised(result)).toEqual({ aggregates: expectedAggregates, rankings: expectedRankings, counts: expectedCounts });
  });

  it('A all, written out in full: aroma sum 273,840 - 2 x 17,640 = 238,560; acidity sum 273,840 - 17,640 = 256,200', () => {
    const item = must(result.aggregates.find((i) => i.bean_id === 'beanA' && i.method === undefined));
    expect(item.criteria.aroma).toEqual({ weighted_count: 17_640, sum: 238_560, sum_of_squares: 4_455_360 - 4 * 273_840 + 4 * 17_640 });
    expect(item.criteria.aroma.sum_of_squares).toBe(3_430_560);
    expect(item.criteria.acidity).toEqual({ weighted_count: 17_640, sum: 256_200, sum_of_squares: 3_925_320 });
    expect(item.criteria.overall).toEqual({ weighted_count: 17_640, sum: 273_840, sum_of_squares: 4_455_360 });
  });

  it('bean B has 5 raters of whom one carries buy-again and one an intensity: the part counts are 1 and 1, notes 0', () => {
    for (const item of result.aggregates.filter((i) => i.bean_id === 'beanB')) {
      expect(item.raters).toBe(5);
      expect(item.buy_again).toEqual({ yes: 2520, no: 0 });
      expect(item.intensities).toEqual({ body: { high: 2520 } });
      expect(item.notes).toEqual({});
      expect(item.raters_by_part).toEqual({ buy_again: 1, notes: 0, intensities: { body: 1 }, histograms: {} });
    }
  });

  it('price band case: u1 holds two bands of bean D on one day, and each band is its own weight group', () => {
    // Bean level: 3 cups, 840 each. Band X: 2 cups, 1,260 each (one vote). Band Y: 1 cup, 2,520 (one vote, but 1 rater: no list).
    const d = must(result.aggregates.find((i) => i.bean_id === 'beanD' && i.method === undefined));
    expect(d.criteria.overall.weighted_count).toBe(12_600);
    expect(result.rankings.map((r) => facetKey(r.facet))).toContain('price_band/from_15_to_30');
    expect(result.rankings.map((r) => facetKey(r.facet))).not.toContain('price_band/from_30_to_45');
  });

  it('a wrong per-method weight changes an order, and a wrong per-band weight changes an order (the fixture can tell them apart)', () => {
    const right = oracle(fixtureInput);
    const listOf = (r: ReturnType<typeof oracle>, key: string): readonly string[] => must(r.rankings.find((l) => facetKey(l.facet) === key)).bean_ids;
    expect(listOf(right, 'method/v60')).toEqual(['beanB', 'beanA', 'beanD']);
    // Method groups taken from the bean level (840 for u1's two v60 cups): A's v60 mean 216,720 / 14,280 = 15.18 passes B (15.00).
    expect(listOf(oracle(fixtureInput, { methodWeights: 'bean' }), 'method/v60')).toEqual(['beanA', 'beanB', 'beanD']);
    expect(listOf(right, 'price_band/from_15_to_30')).toEqual(['beanA', 'beanD', 'beanB']);
    // Band groups taken from the bean level: D's band mean 174,720 / 11,760 = 14.86 falls behind B (15.00).
    expect(listOf(oracle(fixtureInput, { bandWeights: 'bean' }), 'price_band/from_15_to_30')).toEqual(['beanA', 'beanB', 'beanD']);
    // rebuild() takes the right groups.
    expect(listOf(result, 'method/v60')).toEqual(['beanB', 'beanA', 'beanD']);
    expect(listOf(result, 'price_band/from_15_to_30')).toEqual(['beanA', 'beanD', 'beanB']);
  });

  it('the oracle, which shares no code with rebuild(), computes the same output as the hand arithmetic', () => {
    expect(normalised(oracle(fixtureInput))).toEqual({ aggregates: expectedAggregates, rankings: expectedRankings, counts: expectedCounts });
  });

  it('is byte-identical in any order of brews, shelf entries, beans and profiles', () => {
    const expected = JSON.stringify(result);
    for (let seed = 1; seed <= 25; seed += 1) expect(JSON.stringify(rebuild(shuffledHistory(new Rng(seed), fixtureInput)))).toBe(expected);
  });

  it('contains no user id, brew id or shelf entry id', () => {
    const text = JSON.stringify(result);
    for (const id of fixtureInput.brews.flatMap((b) => [b.userId, b.brew.brew_id])) expect(text.includes(`"${id}"`), id).toBe(false);
    for (const { entry } of fixtureInput.shelfEntries) expect(text.includes(entry.shelf_entry_id), entry.shelf_entry_id).toBe(false);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKEND_DIR } from '../../scripts/codegen/paths.ts';
import { DAILY_CAP, MIN_RATERS, WEIGHT_DENOMINATOR } from '../../src/aggregation/config.ts';
import { meanPointsTenths, spreadPointsTenths, varianceHalfPointsSquared } from '../../src/aggregation/arithmetic.ts';
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import { RebuildInputError, type AggregateItem, type RebuildInput } from '../../src/aggregation/rebuild/types.ts';
import { REASON_IDS } from '../../src/generated/aggregation.ts';
import { bean, brew, crowd, DAY, entry, input, MIN, rated, RUN, scores, T0 } from './rebuild-fixtures.ts';

const L = WEIGHT_DENOMINATOR;

function find(items: readonly AggregateItem[], beanId: string, method?: string): AggregateItem {
  const found = items.find((i) => i.bean_id === beanId && i.method === method);
  if (!found) throw new Error(`no item for ${beanId} ${String(method)}`);
  return found;
}

/** `n` cups of one bean on one day, 10 minutes apart, overall scores from `overalls`. */
function day(n: number, overalls: readonly number[], over: { method?: 'v60' | 'espresso'; user?: string; at?: number; prefix?: string } = {}): RebuildInput {
  const user = over.user ?? 'u1';
  return input({
    shelfEntries: [entry({ user })],
    brews: Array.from({ length: n }, (_, i) =>
      brew({ user, id: `${over.prefix ?? 'b'}${String(i).padStart(2, '0')}`, at: (over.at ?? T0) + i * 10 * MIN, method: over.method ?? 'v60', rating: rated(overalls[i % overalls.length] ?? 8) }),
    ),
  });
}

describe('weights (ADR 0035 point 3)', () => {
  it('3 cups of one bean on one day weigh L/3 each and the day totals exactly one vote', () => {
    const result = rebuild(day(3, [8]));
    const item = find(result.aggregates, 'bean1');
    // 3 cups, n = 3, weight 2520 / 3 = 840 each; overall = 8 points = 16 half-points.
    expect(item.criteria.overall).toEqual({ weighted_count: 3 * 840, sum: 3 * 840 * 16, sum_of_squares: 3 * 840 * 256 });
    expect(item.criteria.overall.weighted_count).toBe(L);
    expect(item.raters).toBe(1);
  });

  it.each(Array.from({ length: DAILY_CAP }, (_, i) => i + 1))('n = %i cups weigh exactly one vote together', (n) => {
    const item = find(rebuild(day(n, [8])).aggregates, 'bean1');
    for (const totals of Object.values(item.criteria)) expect(totals.weighted_count).toBe(L);
    expect(item.criteria.overall.sum).toBe(L * 16);
    expect(item.criteria.overall.weighted_count % (L / n)).toBe(0);
  });

  it('two methods on one day: bean level n = 3, method level n = 2 and n = 1', () => {
    const result = rebuild(
      input({
        shelfEntries: [entry()],
        brews: [
          brew({ id: 'a', at: T0, method: 'espresso', rating: rated(8) }),
          brew({ id: 'b', at: T0 + 10 * MIN, method: 'espresso', rating: rated(6) }),
          brew({ id: 'c', at: T0 + 20 * MIN, method: 'v60', rating: rated(10) }),
        ],
      }),
    );
    // Bean level: n = 3, weight 840 each: sum = 840 x (16 + 12 + 20) = 40,320; weighted count 2520.
    const all = find(result.aggregates, 'bean1');
    expect(all.criteria.overall).toMatchObject({ weighted_count: 2520, sum: 840 * (16 + 12 + 20) });
    // Espresso: n = 2, weight 1260 each: sum = 1260 x (16 + 12) = 35,280; weighted count 2520.
    expect(find(result.aggregates, 'bean1', 'espresso').criteria.overall).toMatchObject({ weighted_count: 2520, sum: 1260 * (16 + 12) });
    // V60: n = 1, weight 2520: sum = 2520 x 20 = 50,400.
    expect(find(result.aggregates, 'bean1', 'v60').criteria.overall).toMatchObject({ weighted_count: 2520, sum: 2520 * 20 });
  });

  it('cups of one bean on two days are two votes; the cup after midnight UTC is another group', () => {
    const at = Date.UTC(2026, 10, 20, 23, 55, 0);
    const result = rebuild(day(2, [8], { at }));
    expect(find(result.aggregates, 'bean1').criteria.overall.weighted_count).toBe(2 * L);
  });

  it('two users on one bean give 2 raters; one user across 30 days gives 1 rater', () => {
    expect(find(rebuild(input(crowd(2))).aggregates, 'bean1').raters).toBe(2);
    expect(find(rebuild(input(crowd(1, { perUser: 30, extra: (_, i) => ({ at: T0 - i * DAY }) }))).aggregates, 'bean1')).toMatchObject({ raters: 1, criteria: { overall: { weighted_count: 30 * L } } });
  });

  it('applies the cap before n: 12 cups in a day give n = 10 and one vote; the 2 extra are counted as daily_cap_exceeded', () => {
    const result = rebuild(day(12, [6, 8, 10]));
    const item = find(result.aggregates, 'bean1');
    expect(item.criteria.overall.weighted_count).toBe(L);
    expect(result.counts).toMatchObject({ brews_seen: 12, brews_counted: 10 });
    expect(result.counts.reasons.daily_cap_exceeded).toBe(2);
    // The same output as a history of the first 10 only.
    expect(rebuild(day(10, [6, 8, 10])).aggregates).toEqual(result.aggregates);
  });

  it('a cup that carries a part weighs the cup weight, not the weight of the carriers', () => {
    const result = rebuild(
      input({
        shelfEntries: [entry()],
        brews: [
          brew({ id: 'a', at: T0, rating: { ...rated(8), buy_again: true } }),
          brew({ id: 'b', at: T0 + 10 * MIN, rating: rated(8) }),
          brew({ id: 'c', at: T0 + 20 * MIN, rating: { ...rated(8), buy_again: false } }),
        ],
      }),
    );
    expect(find(result.aggregates, 'bean1').buy_again).toEqual({ yes: 840, no: 840 });
  });
});

describe('exactness', () => {
  it('a set whose naive float mean differs in the last digits gives exact integer sums and the exact rational mean', () => {
    // One user, 3 cups, n = 3: scores 7.5, 8, 6.5 = 15, 16, 13 half-points. Naive: (15 + 16 + 13) / 3 weighted by 1/3 drifts.
    const result = rebuild(day(3, [7.5, 8, 6.5]));
    const { overall } = find(result.aggregates, 'bean1').criteria;
    expect(overall.sum).toBe(840 * (15 + 16 + 13));
    expect(overall.sum).toBe(36_960);
    expect(Number.isSafeInteger(overall.sum_of_squares)).toBe(true);
    expect(overall.sum_of_squares).toBe(840 * (225 + 256 + 169));
    // mean = 36,960 / 2,520 = 44 / 3 half-points exactly (14.666...), i.e. 7.333... points.
    expect(BigInt(overall.sum) * 3n).toBe(44n * BigInt(overall.weighted_count));
    expect(meanPointsTenths({ weightedCount: overall.weighted_count, sum: overall.sum, sumOfSquares: overall.sum_of_squares })).toBe(73);
    // Naive floating-point weights 1/3 do not give the exact fraction.
    const naive = (15 / 3 + 16 / 3 + 13 / 3) / (3 / 3);
    expect(naive * 3).not.toBe(44);
  });

  it('the spread from the sums equals a BigInt reference computed from the raw cups', () => {
    const overalls = [9, 5, 7.5, 6.5, 10, 4, 8];
    const base = crowd(7, { overall: (u) => overalls[u - 1] ?? 8 });
    const item = find(rebuild(input(base)).aggregates, 'bean1');
    const totals = { weightedCount: item.criteria.overall.weighted_count, sum: item.criteria.overall.sum, sumOfSquares: item.criteria.overall.sum_of_squares };
    // Reference: 7 users, one cup each, weight L: W = 7L, S = L x sum(h), SS = L x sum(h^2), variance = (W x SS - S^2) / W^2.
    const h = overalls.map((o) => BigInt(o * 2));
    const W = 7n * BigInt(L);
    const S = BigInt(L) * h.reduce((a, b) => a + b, 0n);
    const SS = BigInt(L) * h.reduce((a, b) => a + b * b, 0n);
    expect(varianceHalfPointsSquared(totals)).toEqual({ numerator: W * SS - S * S, denominator: W * W });
    const sd = Math.sqrt(Number(W * SS - S * S) / Number(W * W)) / 2;
    expect(spreadPointsTenths(totals)).toBe(Math.round(sd * 10));
  });
});

describe('distinct raters per part', () => {
  it('a bean with 5 raters of whom one logged buy-again and one intensity carries part counts of 1', () => {
    const result = rebuild(
      input(
        crowd(5, {
          extra: (u) => (u === 1 ? { rating: { ...rated(8), buy_again: true, intensities: { acidity: 'high' }, flavour_notes: ['berry', 'cherry'] } } : {}),
        }),
      ),
    );
    const item = find(result.aggregates, 'bean1');
    expect(item.raters).toBe(5);
    expect(item.raters_by_part).toEqual({ buy_again: 1, notes: 1, intensities: { acidity: 1 }, histograms: {} });
    expect(item.buy_again).toEqual({ yes: L, no: 0 });
    expect(item.intensities).toEqual({ acidity: { high: L } });
    expect(item.notes).toEqual({ berry: L, cherry: L });
    // No part is hidden here: that is the read path's job (M3-T7).
    expect(item.criteria.overall.weighted_count).toBe(5 * L);
  });

  it('a user who logged the part on several days still counts once', () => {
    const result = rebuild(input(crowd(1, { perUser: 3, extra: (_, i) => ({ at: T0 + i * DAY, rating: { ...rated(8), buy_again: true } }) })));
    expect(find(result.aggregates, 'bean1').raters_by_part.buy_again).toBe(1);
    expect(find(result.aggregates, 'bean1').buy_again.yes).toBe(3 * L);
  });
});

describe('histograms', () => {
  const one = (parameters: Parameters<typeof brew>[0]['parameters'], method: 'v60' | 'espresso' | 'cold_brew' | 'cezve' = 'v60'): AggregateItem['histograms'] =>
    find(rebuild(input({ shelfEntries: [entry()], brews: [brew({ id: 'a', at: T0, method, parameters })] })).aggregates, 'bean1').histograms;

  it('assigns the ratio bucket with the integer test; the lower edge is inclusive, the upper exclusive', () => {
    // 18.0 g (dose_dg 180) and 270 g water is exactly 1:15.0 = 150 tenths: bucket from_150.
    expect(one({ dose_dg: 180, water_g: 270 }).ratio).toEqual({ ratio_filter_from_150: L });
    // 269 g is 149.4: the bucket below.
    expect(one({ dose_dg: 180, water_g: 269 }).ratio).toEqual({ ratio_filter_from_140: L });
    // 271 g is 150.6: from_150 still.
    expect(one({ dose_dg: 180, water_g: 271 }).ratio).toEqual({ ratio_filter_from_150: L });
    // Espresso has its own set: 18.0 g to 36 g is 1:2.0 = 20 tenths: from_20.
    expect(one({ dose_dg: 180, water_g: 36 }, 'espresso').ratio).toEqual({ ratio_espresso_from_20: L });
  });

  it('a cup without dose or water is in no ratio bucket', () => {
    expect(one({ dose_dg: 180 }).ratio).toBeUndefined();
    expect(one({ water_g: 270 }).ratio).toBeUndefined();
  });

  it('assigns grind, temperature and time through the scaled contract edges', () => {
    const h = one({ grind_normalised: 5.5, water_temp_c: 93, brew_time_s: 150 });
    expect(Object.keys(h.grind_normalised ?? {})).toHaveLength(1);
    expect(Object.keys(h.water_temp_c ?? {})).toHaveLength(1);
    expect(Object.keys(h.brew_time_s ?? {})).toHaveLength(1);
    const lowerEdge = one({ water_temp_c: 93 }).water_temp_c ?? {};
    const upperNeighbour = one({ water_temp_c: 94 }).water_temp_c ?? {};
    expect(Object.keys(lowerEdge)).toHaveLength(1);
    expect(Object.keys(upperNeighbour)).toHaveLength(1);
  });

  it('a method with no set for a parameter adds to no bucket of it (temperature of a cezve)', () => {
    expect(one({ water_temp_c: 93, brew_time_s: 150 }, 'cezve').water_temp_c).toBeUndefined();
  });

  it('counts a part rater per parameter and weights buckets like the cup', () => {
    const result = rebuild(input(crowd(5, { extra: (u) => (u === 1 ? { parameters: { dose_dg: 180, water_g: 270, brew_time_s: 150 } } : {}) })));
    const item = find(result.aggregates, 'bean1');
    expect(item.raters_by_part.histograms).toEqual({ ratio: 1, brew_time_s: 1 });
    expect(item.histograms.ratio).toEqual({ ratio_filter_from_150: L });
  });
});

describe('plausibility, orphans and counts', () => {
  it('has a count for every reason id, zeros included, and the counts add up', () => {
    const result = rebuild(
      input({
        shelfEntries: [entry(), entry({ user: 'u2', id: 'e2' })],
        brews: [
          brew({ id: 'ok', at: T0 }),
          brew({ id: 'unrated', at: T0 + 10 * MIN, rating: null }),
          brew({ id: 'future', at: RUN + 10 * MIN }),
          brew({ user: 'u2', entry: 'e2', id: 'nc', at: T0 }),
          brew({ id: 'orphan', entry: 'missing', at: T0 + 30 * MIN }),
        ],
        consentByUser: new Map([['u1', true]]),
      }),
    );
    expect(Object.keys(result.counts.reasons)).toEqual([...REASON_IDS]);
    expect(result.counts.reasons).toEqual({ no_consent: 1, unrated: 1, brewed_in_future: 1, brewed_before_roast: 0, burst: 0, bag_dose_exceeded: 0, straight_lining: 0, daily_cap_exceeded: 0 });
    expect(result.counts).toMatchObject({ brews_seen: 5, brews_counted: 1, brews_orphaned: 1, users_seen: 2 });
    const rejected = Object.values(result.counts.reasons).reduce((a, b) => a + b, 0);
    expect(result.counts.brews_counted + rejected + result.counts.brews_orphaned).toBe(result.counts.brews_seen);
  });

  it('users_seen counts users whose brews are all rejected, unconsented or orphaned, and is 0 for nothing', () => {
    const result = rebuild(
      input({
        shelfEntries: [entry()],
        brews: [
          brew({ user: 'u1', id: 'a', at: T0 }),
          brew({ user: 'u2', id: 'b', at: T0, entry: 'none' }),
          brew({ user: 'u3', id: 'c', at: T0, entry: 'none' }),
        ],
        consentByUser: new Map([
          ['u1', false],
          ['u2', true],
        ]),
      }),
    );
    expect(result.counts.users_seen).toBe(3);
    expect(result.counts.brews_orphaned).toBe(1);
    expect(result.counts.reasons.no_consent).toBe(2);
    expect(rebuild(input({})).counts.users_seen).toBe(0);
  });

  it('leaves an orphan brew out of every aggregate and rater count', () => {
    const base = crowd(5);
    const withOrphan = rebuild(input({ ...base, brews: [...base.brews, brew({ user: 'u9', id: 'o', entry: 'gone', at: T0 })], consent: ['u1', 'u2', 'u3', 'u4', 'u5', 'u9'] }));
    expect(withOrphan.aggregates).toEqual(rebuild(input(base)).aggregates);
    expect(withOrphan.counts.brews_orphaned).toBe(1);
  });

  it('withdrawing consent gives the output of a history without that user; re-consent restores it', () => {
    const base = crowd(6, { perUser: 2, overall: (u, i) => 4 + ((u + i) % 6) });
    const all = rebuild(input(base));
    const withdrawn = rebuild(input({ ...base, consentByUser: new Map(['u1', 'u2', 'u3', 'u4', 'u5'].map((u) => [u, true])) }));
    const without = rebuild(input({ brews: base.brews.filter((b) => b.userId !== 'u6'), shelfEntries: base.shelfEntries.filter((e) => e.userId !== 'u6') }));
    expect(withdrawn.aggregates).toEqual(without.aggregates);
    expect(withdrawn.rankings).toEqual(without.rankings);
    expect(rebuild(input(base))).toEqual(all);
    expect(all.aggregates).not.toEqual(withdrawn.aggregates);
  });

  it('a deleted brew is simply absent: the output equals a history that never had it', () => {
    const base = crowd(5, { perUser: 3, extra: (_, i) => ({ at: T0 + i * DAY }) });
    const without = { ...base, brews: base.brews.filter((b) => b.brew.brew_id !== 'u2b1') };
    const result = rebuild(input(without));
    expect(find(result.aggregates, 'bean1').criteria.overall.weighted_count).toBe(14 * L);
    expect(find(result.aggregates, 'bean1').criteria.overall.weighted_count).not.toBe(rebuild(input(base)).aggregates[0]?.criteria.overall.weighted_count);
  });

  it('a moved brew (new shelf entry, new bean) moves its cup', () => {
    const base = crowd(5);
    const moved = rebuild(input({ ...base, shelfEntries: [...base.shelfEntries, entry({ user: 'u1', id: 'e9', bean: 'beanX' })], brews: base.brews.map((b) => (b.brew.brew_id === 'u1b0' ? brew({ user: 'u1', id: 'u1b0', entry: 'e9', at: T0 }) : b)) }));
    expect(find(moved.aggregates, 'beanX').raters).toBe(1);
    expect(find(moved.aggregates, 'bean1').raters).toBe(4);
  });

  it('fails the run on a timestamp that does not decode, and on a repeated bean', () => {
    const bad = brew({ id: 'x', at: T0 });
    const broken = { ...bad, brew: { ...bad.brew, values: { ...bad.brew.values, brewed_at: 'not a time' } } };
    expect(() => rebuild(input({ shelfEntries: [entry()], brews: [broken] }))).toThrow(RebuildInputError);
    expect(() => rebuild(input({ beans: [bean('b'), bean('b')] }))).toThrow(RebuildInputError);
    expect(() => rebuild(input({ shelfEntries: [entry()], brews: [brew({ id: 'x', at: T0 }), brew({ id: 'x', at: T0 + MIN })] }))).toThrow();
  });

  it('a bag size resolves against the shelf entry version: a brew over the bag is judged, an unknown size is not', () => {
    const over = (version: 1 | 3) =>
      rebuild(
        input({
          shelfEntries: [entry({ bagSize: 'g_250', version })],
          brews: [brew({ id: 'a', at: T0, parameters: { dose_dg: 1000 } }), ...Array.from({ length: 4 }, (_, i) => brew({ id: `b${String(i)}`, at: T0 + (i + 1) * 10 * MIN, parameters: { dose_dg: 1000 } }))],
        }),
      );
    // 250 g x 1.10 = 275 g = 2750 dg: 2 doses of 1000 dg fit, the third does not.
    for (const version of [1, 3] as const) expect(over(version).counts.reasons.bag_dose_exceeded).toBe(3);
    const none = rebuild(input({ shelfEntries: [entry()], brews: Array.from({ length: 5 }, (_, i) => brew({ id: `c${String(i)}`, at: T0 + i * 10 * MIN, parameters: { dose_dg: 1000 } })) }));
    expect(none.counts.reasons.bag_dose_exceeded).toBe(0);
  });
});

describe('rankings', () => {
  const five = (over: Parameters<typeof crowd>[1] = {}) => crowd(MIN_RATERS, over);

  it('a bean with 4 raters has its aggregate item but no ranking; with 5 it is ranked', () => {
    const four = rebuild(input(crowd(MIN_RATERS - 1)));
    expect(four.aggregates).toHaveLength(2);
    expect(four.rankings).toEqual([]);
    expect(four.counts.beans_ranked).toBe(0);
    const ok = rebuild(input(five()));
    expect(ok.rankings).toEqual([
      { facet: { kind: 'all' }, run_day: '2026-11-27', bean_ids: ['bean1'] },
      { facet: { kind: 'method', value: 'v60' }, run_day: '2026-11-27', bean_ids: ['bean1'] },
    ]);
  });

  it('orders by exact mean of overall, best first, ties by bean id', () => {
    const a = crowd(5, { bean: 'bB', overall: () => 8 });
    const b = crowd(5, { bean: 'bA', overall: () => 8 });
    const c = crowd(5, { bean: 'bC', overall: () => 9 });
    const d = crowd(5, { bean: 'bD', overall: (u) => (u === 1 ? 7.5 : 8) });
    const merge = (parts: ReturnType<typeof crowd>[]) => {
      // Distinct user ids per bean group: prefix the users.
      return parts.flatMap((p, i) => ({ brews: p.brews.map((x) => ({ ...x, userId: `g${String(i)}${x.userId}`, brew: { ...x.brew, brew_id: `g${String(i)}${x.brew.brew_id}` } })), shelfEntries: p.shelfEntries.map((x) => ({ ...x, userId: `g${String(i)}${x.userId}` })) }));
    };
    const parts = merge([a, b, c, d]);
    const result = rebuild(input({ brews: parts.flatMap((p) => p.brews), shelfEntries: parts.flatMap((p) => p.shelfEntries) }));
    const all = result.rankings.find((r) => r.facet.kind === 'all');
    expect(all?.bean_ids).toEqual(['bC', 'bA', 'bB', 'bD']);
    expect(result.counts.beans_ranked).toBe(4);
  });

  it('is independent of the order of the input', () => {
    const base = crowd(6, { perUser: 3, overall: (u, i) => 4 + ((u * 3 + i) % 6) });
    const reversed = input({ brews: [...base.brews].reverse(), shelfEntries: [...base.shelfEntries].reverse() });
    expect(JSON.stringify(rebuild(reversed))).toBe(JSON.stringify(rebuild(input(base))));
  });

  it('ranks origin, process and roast level only for operator-verified beans, using the operator values', () => {
    const base = crowd(5);
    const verified = bean('bean1', { verified: true, picked_attributes: { process: 'natural' }, operator_attributes: { process: 'washed', roast_level: 'light', origin: 'sumatra' } });
    const facets = rebuild(input({ ...base, beans: [verified] })).rankings.map((r) => r.facet);
    expect(facets).toContainEqual({ kind: 'process', value: 'washed' });
    expect(facets).toContainEqual({ kind: 'roast_level', value: 'light' });
    // A region ranks under its country.
    expect(facets).toContainEqual({ kind: 'origin', value: 'indonesia' });
    expect(facets).not.toContainEqual({ kind: 'process', value: 'natural' });

    const unverified = bean('bean1', { verified: false, picked_attributes: { process: 'natural', roast_level: 'dark', origin: 'kenya' }, operator_attributes: {} });
    expect(rebuild(input({ ...base, beans: [unverified] })).rankings.map((r) => r.facet.kind).sort()).toEqual(['all', 'method']);
    expect(rebuild(input({ ...base })).rankings).toHaveLength(2);
  });

  it('gives blend, other and unknown no ranking', () => {
    for (const attributes of [{ origin: 'blend' }, { origin: 'other' }, { origin: 'unknown' }, { process: 'other' }, { process: 'unknown' }] as const) {
      const facets = rebuild(input({ ...crowd(5), beans: [bean('bean1', { verified: true, operator_attributes: attributes })] })).rankings.map((r) => r.facet.kind);
      expect(facets.sort()).toEqual(['all', 'method']);
    }
  });

  it('builds the price band facet from its own weight groups and its own 5 raters', () => {
    // Users 1 to 5 bought in the band under_15; user 6 bought in from_15_to_30 only.
    const base = crowd(6, { perUser: 2 });
    const shelfEntries = base.shelfEntries.map((e) => entry({ user: e.userId, bean: 'bean1', priceBand: e.userId === 'u6' ? 'from_15_to_30' : 'under_15' }));
    const result = rebuild(input({ brews: base.brews, shelfEntries }));
    const bands = result.rankings.filter((r) => r.facet.kind === 'price_band');
    expect(bands.map((r) => r.facet)).toEqual([{ kind: 'price_band', value: 'under_15' }]);
    // The bean-level item still has all 6 raters.
    expect(find(result.aggregates, 'bean1').raters).toBe(6);
  });

  it('a user buying the same bean in two bands gets a full vote per band, and an entry without a band adds to none', () => {
    // Weight groups per (user, bean, band, day): the same user's cups split by band count one vote each in the band lists.
    const base = crowd(5, { perUser: 2 });
    const shelfEntries = base.shelfEntries.flatMap((e) => [entry({ user: e.userId, bean: 'bean1', priceBand: 'under_15' }), entry({ user: e.userId, id: 'e2', bean: 'bean1', priceBand: 'from_80' })]);
    const brews = base.brews.map((b, i) => (i % 2 === 0 ? b : brew({ user: b.userId, id: b.brew.brew_id, entry: 'e2', at: T0 + 10 * MIN })));
    const result = rebuild(input({ brews, shelfEntries }));
    const kinds = result.rankings.flatMap((r) => (r.facet.kind === 'price_band' ? [r.facet.value] : []));
    expect(kinds).toEqual(['from_80', 'under_15']);
    const noBand = rebuild(input(crowd(5)));
    expect(noBand.rankings.some((r) => r.facet.kind === 'price_band')).toBe(false);
  });
});

describe('output hygiene', () => {
  it('stamps every item with the run day and carries no user id', () => {
    const base = crowd(5, { perUser: 2 });
    const result = rebuild(input(base));
    for (const item of result.aggregates) expect(item.run_day).toBe('2026-11-27');
    for (const item of result.rankings) expect(item.run_day).toBe('2026-11-27');
    const text = JSON.stringify(result);
    for (const { userId } of base.brews) expect(text).not.toContain(userId);
    for (const { brew: b } of base.brews) expect(text).not.toContain(b.brew_id);
  });

  it('an empty history gives an empty result with every reason count at 0', () => {
    const result = rebuild(input({}));
    expect(result.aggregates).toEqual([]);
    expect(result.rankings).toEqual([]);
    expect(Object.values(result.counts.reasons)).toEqual(REASON_IDS.map(() => 0));
  });

  it('stores every item with only integers and ids: sums are safe integers', () => {
    const result = rebuild(input(crowd(8, { perUser: 5 })));
    const visit = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(result.aggregates);
  });

  it('the rebuild module reads no clock, I/O or reference recipe', () => {
    const dir = join(BACKEND_DIR, 'src', 'aggregation', 'rebuild');
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(text, name).not.toMatch(/Date\.now|new Date\s*\(\s*\)|Math\.random|node:|@aws-sdk|\bfetch\b|\bawait\b|contracts\/reference|reference\//);
      for (const m of text.matchAll(/from '([^']+)'/g)) expect(m[1], name).toMatch(/^\.{1,2}\//);
    }
    expect(scores(1, 2)).toBeDefined();
  });
});

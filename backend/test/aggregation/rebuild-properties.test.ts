// Seeded property tests of the rebuild against the independent oracle (M3-T6, ADR 0035).
// Every property runs on CAMPAIGN_SIZE generated histories (seeds 1..CAMPAIGN_SIZE); a
// failure names its seed. The oracle (support/oracle.ts) shares no code with src.
import { describe, expect, it, vi } from 'vitest';
import { DAILY_CAP, WEIGHT_DENOMINATOR } from '../../src/aggregation/config.ts';
import { rebuild } from '../../src/aggregation/rebuild/rebuild.ts';
import type { RebuildBrew, RebuildInput, RebuildResult } from '../../src/aggregation/rebuild/types.ts';
import { REASON_IDS, type ReasonId } from '../../src/generated/aggregation.ts';
import type { Scores } from '../../src/generated/contract.ts';
import { bean, brew, entry, input, MIN, rated, RUN, scores, T0 } from './rebuild-fixtures.ts';
import { CAMPAIGN_SIZE, forEachSeed, normalised, numbersOf, visitNumbers } from './support/campaign.ts';
import { genCrowd, genHistory, scoresOf, shuffledHistory, sameBrew, withConsent, withoutBrews } from './support/histories.ts';
import { analyse, compareRat, oracle, rat, verdictKey } from './support/oracle.ts';
import type { Rng } from './support/rng.ts';

// A campaign of 300 histories checked against the slow oracle takes a few seconds; do not let a slower machine time out.
vi.setConfig({ testTimeout: 120_000 });

const L = WEIGHT_DENOMINATOR;
const bytes = (result: RebuildResult): string => JSON.stringify(result);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

/** The ids of the five rules that act on one brew at a time or on a window of live brews: the per-rule property holds for these (T6 note). */
const REMOVABLE_RULES: readonly ReasonId[] = ['no_consent', 'unrated', 'brewed_in_future', 'brewed_before_roast', 'burst'];

describe('the oracle and rebuild() on random histories', () => {
  it(`agree on the whole output (every item, every ranking, every count) for ${String(CAMPAIGN_SIZE)} wild histories`, () => {
    const seen = { withAggregates: 0, withRankings: 0, brews: 0, reasons: new Map<ReasonId, number>() };
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const actual = rebuild(history);
      expect(normalised(actual)).toEqual(normalised(oracle(history)));
      if (actual.aggregates.length > 0) seen.withAggregates += 1;
      if (actual.rankings.length > 0) seen.withRankings += 1;
      seen.brews += actual.counts.brews_seen;
      for (const id of REASON_IDS) seen.reasons.set(id, (seen.reasons.get(id) ?? 0) + (actual.counts.reasons[id] > 0 ? 1 : 0));
    });
    // The campaign is not vacuous: most histories have aggregates, many have rankings, every reason occurs often.
    expect(seen.withAggregates).toBeGreaterThan(CAMPAIGN_SIZE * 0.8);
    expect(seen.withRankings).toBeGreaterThan(CAMPAIGN_SIZE * 0.3);
    for (const id of REASON_IDS) expect(seen.reasons.get(id) ?? 0, id).toBeGreaterThanOrEqual(30);
  });

  it('agree on crowded histories built to fill the ranking lists, and those lists are rich enough to tell wrong weights apart', () => {
    const seen = { twoBeans: 0, bandLists: 0, methodLists: 0, bandWrong: 0, methodWrong: 0 };
    forEachSeed((rng) => {
      const history = genCrowd(rng);
      const actual = rebuild(history);
      expect(normalised(actual)).toEqual(normalised(oracle(history)));
      const lists = actual.rankings;
      if ((lists.find((r) => r.facet.kind === 'all')?.bean_ids.length ?? 0) >= 2) seen.twoBeans += 1;
      if (lists.some((r) => r.facet.kind === 'price_band')) seen.bandLists += 1;
      if (lists.some((r) => r.facet.kind === 'method')) seen.methodLists += 1;
      // The campaign would notice a wrong band or method weight: with the wrong groups the oracle's lists change in some histories.
      if (JSON.stringify(oracle(history, { bandWeights: 'bean' }).rankings) !== JSON.stringify(normalised(actual).rankings)) seen.bandWrong += 1;
      if (JSON.stringify(oracle(history, { methodWeights: 'bean' }).rankings) !== JSON.stringify(normalised(actual).rankings)) seen.methodWrong += 1;
    });
    expect(seen.twoBeans).toBeGreaterThan(CAMPAIGN_SIZE * 0.5);
    expect(seen.bandLists).toBeGreaterThan(CAMPAIGN_SIZE * 0.3);
    expect(seen.methodLists).toBeGreaterThan(CAMPAIGN_SIZE * 0.3);
    expect(seen.bandWrong).toBeGreaterThanOrEqual(10);
    expect(seen.methodWrong).toBeGreaterThanOrEqual(10);
  });

  it('agree on clean histories too (no cross-brew rule in the way)', () => {
    forEachSeed((rng) => {
      const history = genHistory(rng, 'clean');
      expect(normalised(rebuild(history))).toEqual(normalised(oracle(history)));
    });
  });

  it('can tell a wrong method weight apart: weighing a method by bean-level groups changes the numbers of many histories', () => {
    let differs = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng, 'clean');
      if (JSON.stringify(oracle(history, { methodWeights: 'bean' }).aggregates) !== JSON.stringify(oracle(history).aggregates)) differs += 1;
    });
    expect(differs).toBeGreaterThan(CAMPAIGN_SIZE * 0.2);
  });
});

describe('order independence', () => {
  it('shuffling brews, shelf entries, beans and profiles gives byte-identical output', () => {
    forEachSeed((rng) => {
      const history = rng.chance(0.5) ? genHistory(rng) : genCrowd(rng);
      const expected = bytes(rebuild(history));
      for (let i = 0; i < 2; i += 1) {
        const shuffled = shuffledHistory(rng, history);
        expect(bytes(rebuild(shuffled))).toBe(expected);
      }
    });
  });
});

describe('consent flips', () => {
  it('withdrawing consent removes exactly that user\'s contributions; re-consent restores the original output exactly', () => {
    let flipped = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const original = rebuild(history);
      const consenting = [...history.consentByUser.entries()].filter(([, v]) => v).map(([u]) => u);
      if (consenting.length === 0) return;
      const user = rng.pick(consenting);

      const withdrawn = withConsent(history, user, false);
      const without = withoutBrews(history, (b) => b.userId === user);
      expect(numbersOf(rebuild(withdrawn))).toEqual(numbersOf(rebuild(without)));
      expect(numbersOf(rebuild(withdrawn))).toEqual(numbersOf(oracle(withdrawn)));
      // No profile at all is the same as consent false.
      expect(bytes(rebuild(withConsent(history, user, undefined)))).toBe(bytes(rebuild(withdrawn)));
      // The user's brews are now rejected as no_consent, nothing else changes in the counts.
      const mine = history.brews.filter((b) => b.userId === user).length;
      expect(rebuild(withdrawn).counts.brews_seen).toBe(original.counts.brews_seen);
      expect(rebuild(withdrawn).counts.brews_counted).toBeLessThanOrEqual(original.counts.brews_counted);
      if (mine > 0 && rebuild(without).counts.brews_counted !== original.counts.brews_counted) flipped += 1;

      // Re-consent: the profile as it is at run time decides, so the original output is back, byte for byte.
      expect(bytes(rebuild(withConsent(withdrawn, user, true)))).toBe(bytes(original));
    });
    expect(flipped).toBeGreaterThan(CAMPAIGN_SIZE * 0.3);
  });
});

/** A tiny store: the events of a user's log, replayed into the history the repository would scan. */
type Op =
  | { readonly op: 'create'; readonly brew: RebuildBrew }
  | { readonly op: 'delete'; readonly userId: string; readonly brewId: string }
  | { readonly op: 'edit'; readonly userId: string; readonly brewId: string; readonly scores: Scores };

function replay(base: RebuildInput, ops: readonly Op[]): RebuildInput {
  const store = new Map<string, RebuildBrew>();
  const key = (userId: string, brewId: string): string => verdictKey(userId, brewId);
  for (const op of ops) {
    if (op.op === 'create') store.set(key(op.brew.userId, op.brew.brew.brew_id), op.brew);
    else if (op.op === 'delete') store.delete(key(op.userId, op.brewId));
    else {
      const old = store.get(key(op.userId, op.brewId));
      const rating = old?.brew.values.rating;
      if (!old || !rating) throw new Error('edit of a brew without a rating');
      store.set(key(op.userId, op.brewId), { userId: old.userId, brew: { ...old.brew, values: { ...old.brew.values, rating: { ...rating, scores: op.scores } } } });
    }
  }
  return { ...base, brews: [...store.values()] };
}

describe('deleted and edited brews', () => {
  it('a brew that was created and then deleted gives the output of a history that never had it', () => {
    let changed = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const doomed = history.brews.filter(() => rng.chance(0.08));
      const created: Op[] = rng.shuffle(history.brews).map((b) => ({ op: 'create', brew: b }));
      const deleted: Op[] = doomed.map((b) => ({ op: 'delete', userId: b.userId, brewId: b.brew.brew_id }));
      const afterDelete = replay(history, [...created, ...deleted]);
      const neverHad = withoutBrews(history, (b) => doomed.some((d) => sameBrew(b, d.userId, d.brew.brew_id)));
      expect(bytes(rebuild(afterDelete))).toBe(bytes(rebuild(neverHad)));
      expect(normalised(rebuild(afterDelete))).toEqual(normalised(oracle(neverHad)));
      if (bytes(rebuild(afterDelete)) !== bytes(rebuild(history))) changed += 1;
    });
    expect(changed).toBeGreaterThan(CAMPAIGN_SIZE * 0.4);
  });

  it('a brew whose scores were edited gives the output of a history created with the new scores', () => {
    let changed = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const edits = history.brews.filter((b) => b.brew.values.rating !== undefined && rng.chance(0.1)).map((b) => ({ b, scores: scoresOf(() => rng.int(2, 20) / 2) }));
      const old: Op[] = history.brews.map((b) => ({ op: 'create', brew: b }));
      const edited: Op[] = edits.map(({ b, scores: s }) => ({ op: 'edit', userId: b.userId, brewId: b.brew.brew_id, scores: s }));
      const afterEdit = replay(history, [...old, ...edited]);
      const direct = replay(history, history.brews.map((b): Op => {
        const hit = edits.find((e) => sameBrew(b, e.b.userId, e.b.brew.brew_id));
        const rating = b.brew.values.rating;
        if (!hit || !rating) return { op: 'create', brew: b };
        return { op: 'create', brew: { userId: b.userId, brew: { ...b.brew, values: { ...b.brew.values, rating: { ...rating, scores: hit.scores } } } } };
      }));
      expect(bytes(rebuild(afterEdit))).toBe(bytes(rebuild(direct)));
      expect(normalised(rebuild(afterEdit))).toEqual(normalised(oracle(direct)));
      if (bytes(rebuild(afterEdit)) !== bytes(rebuild(history))) changed += 1;
    });
    expect(changed).toBeGreaterThan(CAMPAIGN_SIZE * 0.3);
  });
});

/** One consenting user, one bean, plain brews (no rule in the way): days of 1 to 10 cups on up to two methods. */
function oneUserDays(rng: Rng): { history: RebuildInput; days: { cups: { method: 'v60' | 'espresso'; half: number }[] }[] } {
  const days = Array.from({ length: rng.int(1, 6) }, () => ({
    cups: Array.from({ length: rng.int(1, DAILY_CAP) }, () => ({ method: rng.pick(['v60', 'espresso'] as const), half: rng.int(4, 20) })),
  }));
  const brews = days.flatMap((day, d) =>
    day.cups.map((cup, i) => brew({ user: 'u1', id: `b${String(d)}x${String(i).padStart(2, '0')}`, at: T0 + d * 86_400_000 + i * 10 * MIN, method: cup.method, rating: { scores: scores((cup.half - 2) / 2, cup.half / 2, cup.half / 2, cup.half / 2, cup.half / 2, cup.half / 2, cup.half / 2, cup.half / 2) } })),
  );
  return { history: input({ shelfEntries: [entry()], brews }), days };
}

describe('weights', () => {
  it('the weights of a user, bean and UTC day sum to exactly L, so the weighted count is L x days, at bean level and per method', () => {
    forEachSeed((rng) => {
      const { history, days } = oneUserDays(rng);
      const result = rebuild(history);
      const all = must(result.aggregates.find((i) => i.kind === 'all'));
      for (const totals of Object.values(all.criteria)) expect(totals.weighted_count).toBe(L * days.length);
      for (const method of ['v60', 'espresso'] as const) {
        const withMethod = days.filter((d) => d.cups.some((c) => c.method === method)).length;
        const item = result.aggregates.find((i) => i.method === method);
        if (withMethod === 0) expect(item).toBeUndefined();
        else for (const totals of Object.values(must(item).criteria)) expect(totals.weighted_count).toBe(L * withMethod);
      }
      // The same history without consent adds nothing: the sum of weights is 0 (no item).
      expect(rebuild(withConsent(history, 'u1', false)).aggregates).toEqual([]);
    });
  });

  it.each(Array.from({ length: DAILY_CAP }, (_, i) => i + 1))('n = %i cups of one day each weigh L / n: the sum is L / n x the sum of half-points, hand formula', (n) => {
    forEachSeed((rng) => {
      const halves = Array.from({ length: n }, () => rng.int(4, 20));
      const history = input({
        shelfEntries: [entry()],
        brews: halves.map((h, i) => brew({ id: `b${String(i).padStart(2, '0')}`, at: T0 + i * 10 * MIN, rating: { scores: scores((h - 2) / 2, h / 2, h / 2, h / 2, h / 2, h / 2, h / 2, h / 2) } })),
      });
      const all = must(rebuild(history).aggregates.find((i) => i.kind === 'all'));
      expect(L % n).toBe(0);
      const weight = L / n;
      const total = halves.reduce((a, h) => a + h, 0);
      const squares = halves.reduce((a, h) => a + h * h, 0);
      expect(all.criteria.overall).toEqual({ weighted_count: L, sum: weight * total, sum_of_squares: weight * squares });
    }, 60);
  });
});

describe('the daily cap', () => {
  it('with 11 or more cups in a day the output equals that of the first 10 only', () => {
    let capped = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng, 'clean');
      const verdicts = analyse(history).verdicts;
      const extras = history.brews.filter((b) => verdicts.get(verdictKey(b.userId, b.brew.brew_id)) === 'daily_cap_exceeded');
      const firstTen = withoutBrews(history, (b) => extras.includes(b));
      expect(numbersOf(rebuild(firstTen))).toEqual(numbersOf(rebuild(history)));
      expect(numbersOf(rebuild(history))).toEqual(numbersOf(oracle(history)));
      if (extras.length > 0) capped += 1;
    });
    expect(capped).toBeGreaterThan(CAMPAIGN_SIZE * 0.2);
  });

  it.each([11, 12, 15, 20, 25])('one user with %i cups in a day: the output of the first 10 only, by time then brew id', (cups) => {
    forEachSeed((rng) => {
      const halves = Array.from({ length: cups }, () => rng.int(4, 20));
      const make = (count: number): RebuildInput =>
        input({
          shelfEntries: [entry()],
          brews: halves.slice(0, count).map((h, i) => brew({ id: `b${String(i).padStart(2, '0')}`, at: T0 + i * 5 * MIN, rating: { scores: scores((h - 2) / 2, h / 2, h / 2, h / 2, h / 2, h / 2, h / 2, h / 2) } })),
        });
      // Shuffle the listing order: the first 10 are the oldest, not the first listed.
      const full = make(cups);
      const shuffled = { ...full, brews: rng.shuffle(full.brews) };
      const resultFull = rebuild(shuffled);
      expect(numbersOf(resultFull)).toEqual(numbersOf(rebuild(make(DAILY_CAP))));
      expect(resultFull.counts).toMatchObject({ brews_seen: cups, brews_counted: DAILY_CAP });
      expect(resultFull.counts.reasons.daily_cap_exceeded).toBe(cups - DAILY_CAP);
    }, 40);
  });
});

describe('each plausibility rule that has the property (rules 1 to 5)', () => {
  it.each(REMOVABLE_RULES)('%s: a brew rejected by the rule leaves the output equal to a history without it', (reason) => {
    let applied = 0;
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const original = rebuild(history);
      const verdicts = analyse(history).verdicts;
      const rejected = history.brews.filter((b) => verdicts.get(verdictKey(b.userId, b.brew.brew_id)) === reason);
      if (rejected.length === 0) return;
      applied += 1;
      // One rejected brew removed.
      const one = must(rejected[rng.int(0, rejected.length - 1)]);
      const withoutOne = withoutBrews(history, (b) => sameBrew(b, one.userId, one.brew.brew_id));
      expect(numbersOf(rebuild(withoutOne))).toEqual(numbersOf(original));
      // All brews rejected by the rule removed at once.
      const withoutAll = rebuild(withoutBrews(history, (b) => rejected.includes(b)));
      expect(numbersOf(withoutAll)).toEqual(numbersOf(original));
      expect(withoutAll.counts.brews_seen).toBe(original.counts.brews_seen - rejected.length);
      expect(withoutAll.counts.reasons[reason]).toBe(original.counts.reasons[reason] - rejected.length);
      expect(withoutAll.counts.brews_counted).toBe(original.counts.brews_counted);
    });
    expect(applied).toBeGreaterThanOrEqual(40);
  });
});

describe('exact arithmetic', () => {
  it('every number is a safe integer, weighted counts are L x votes, and sum / weighted count is the BigInt reference mean', () => {
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const result = rebuild(history);
      visitNumbers(result, (n) => {
        expect(Number.isSafeInteger(n)).toBe(true);
      });
      const { means, votes } = analyse(history);
      for (const item of result.aggregates) {
        const key = item.method === undefined ? item.bean_id : `${item.bean_id}\u0001${item.method}`;
        const reference = must(means.get(key));
        for (const [criterion, totals] of Object.entries(item.criteria) as [keyof typeof item.criteria, (typeof item.criteria)[keyof typeof item.criteria]][]) {
          expect(BigInt(totals.weighted_count)).toBe(BigInt(L) * must(votes.get(key)));
          // sum / weighted count equals the rational mean, compared by cross multiplication in BigInt (no float).
          const actual = rat(BigInt(totals.sum), BigInt(totals.weighted_count));
          expect(compareRat(actual, reference[criterion]), `${key} ${criterion}`).toBe(0);
          // The mean is a point count of half-points between 1 and 20 (never outside the grid).
          expect(compareRat(actual, rat(2n))).toBeGreaterThanOrEqual(0);
          expect(compareRat(actual, rat(20n))).toBeLessThanOrEqual(0);
        }
      }
    });
  });

  it('a large crowd stays exact: 4,000 users with one cup of 10 points weigh 4,000 x L and the sum of squares is the closed form', () => {
    const users = 4000;
    const brews = Array.from({ length: users }, (_, i) => brew({ user: `u${String(i)}`, id: `b${String(i)}`, at: T0, rating: rated(10) }));
    const shelf = Array.from({ length: users }, (_, i) => entry({ user: `u${String(i)}` }));
    const item = must(rebuild(input({ brews, shelfEntries: shelf })).aggregates.find((i) => i.kind === 'all'));
    expect(item.raters).toBe(users);
    // overall = 10 points = 20 half-points: sum = users x L x 20, squares = users x L x 400.
    expect(item.criteria.overall).toEqual({ weighted_count: users * L, sum: users * L * 20, sum_of_squares: users * L * 400 });
  });
});

describe('output hygiene', () => {
  it('no user id, brew id or shelf entry id appears anywhere in the output', () => {
    forEachSeed((rng) => {
      const history = genHistory(rng);
      const text = bytes(rebuild(history));
      const ids = [...history.brews.map((b) => b.userId), ...history.brews.map((b) => b.brew.brew_id), ...history.shelfEntries.map((e) => e.entry.shelf_entry_id)];
      for (const id of new Set(ids)) expect(text.includes(id), id).toBe(false);
    });
  });

  it('the rebuild of an empty history is empty and does not throw', () => {
    const empty: RebuildInput = { brews: [], shelfEntries: [], beans: [], consentByUser: new Map(), runTimeMs: RUN };
    const result = rebuild(empty);
    expect(result.aggregates).toEqual([]);
    expect(result.rankings).toEqual([]);
    expect(result.counts.brews_seen).toBe(0);
    expect(normalised(result)).toEqual(normalised(oracle(empty)));
    // Beans and shelf entries without a single brew are empty too.
    expect(rebuild({ ...empty, beans: [bean('bean1')], shelfEntries: [entry()], consentByUser: new Map([['u1', true]]) }).aggregates).toEqual([]);
  });
});

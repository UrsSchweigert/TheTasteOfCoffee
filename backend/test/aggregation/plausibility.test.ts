import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKEND_DIR } from '../../scripts/codegen/paths.ts';
import { REASON_IDS } from '../../src/generated/aggregation.ts';
import type { Scores } from '../../src/generated/contract.ts';
import {
  BAG_DOSE_MARGIN_PERCENT,
  BURST_COUNT,
  BURST_WINDOW_MS,
  DAILY_CAP,
  FUTURE_SKEW_MS,
  STRAIGHT_LINING_MIN_BREWS,
} from '../../src/aggregation/config.ts';
import { judgeBrews } from '../../src/aggregation/plausibility/judge.ts';
import { RULES } from '../../src/aggregation/plausibility/rules.ts';
import {
  PlausibilityInputError,
  type BrewVerdict,
  type PlausibilityBrew,
  type PlausibilityShelfEntry,
  type Verdict,
} from '../../src/aggregation/plausibility/types.ts';

const RUN = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const SEC = 1000;
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0); // a week before the run, 09:00 UTC

const MIXED: Scores = { aroma: 7, flavour: 8, aftertaste: 8, acidity: 8, body: 8, sweetness: 8, balance: 8, overall: 8 };
function uniform(value: number): Scores {
  return { aroma: value, flavour: value, aftertaste: value, acidity: value, body: value, sweetness: value, balance: value, overall: value };
}

const consent = (...users: string[]): Map<string, boolean> => new Map(users.map((u) => [u, true]));
const entry = (over: Partial<PlausibilityShelfEntry> = {}): PlausibilityShelfEntry => ({
  userId: 'u1',
  shelfEntryId: 'e1',
  beanId: 'b1',
  ...over,
});
const brew = (brewId: string, brewedAtMs: number, over: Partial<PlausibilityBrew> = {}): PlausibilityBrew => ({
  userId: 'u1',
  brewId,
  shelfEntryId: 'e1',
  brewedAtMs,
  scores: MIXED,
  ...over,
});
/** n brews spaced `step` ms apart from `start`, ids `p00`, `p01`, ... */
const series = (n: number, start: number, step: number, over: Partial<PlausibilityBrew> = {}, prefix = 'p'): PlausibilityBrew[] =>
  Array.from({ length: n }, (_, i) => brew(`${prefix}${String(i).padStart(2, '0')}`, start + i * step, over));

function verdicts(
  brews: readonly PlausibilityBrew[],
  entries: readonly PlausibilityShelfEntry[] = [entry()],
  consents: ReadonlyMap<string, boolean> = consent('u1'),
  runTime = RUN,
): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const v of judgeBrews(brews, entries, consents, runTime).verdicts) out[`${v.userId}/${v.brewId}`] = v.verdict;
  return out;
}
/** The verdict of the first brew of a one-brew history. */
function only(brews: readonly PlausibilityBrew[], e = entry(), c = consent('u1'), runTime = RUN): Verdict {
  const [first] = judgeBrews(brews, [e], c, runTime).verdicts;
  if (!first) throw new Error('no verdict');
  return first.verdict;
}

describe('rule 1: no consent', () => {
  it.each([
    ['true', new Map([['u1', true]]), 'counted'],
    ['false', new Map([['u1', false]]), 'no_consent'],
    ['no profile', new Map<string, boolean>(), 'no_consent'],
    ['only another user consented', new Map([['u2', true]]), 'no_consent'],
  ] as const)('consent %s', (_, c, expected) => {
    expect(only([brew('a', T0)], entry(), c)).toBe(expected);
  });
});

describe('rule 2: unrated', () => {
  it('a brew without a rating is unrated, one with a rating counts', () => {
    expect(verdicts([brew('a', T0, { scores: undefined }), brew('b', T0 + HOUR)])).toEqual({ 'u1/a': 'unrated', 'u1/b': 'counted' });
  });
});

describe('rule 3: brewed in the future', () => {
  it('exactly the skew after the run time counts, one millisecond more does not', () => {
    expect(only([brew('a', RUN + FUTURE_SKEW_MS)])).toBe('counted');
    expect(only([brew('a', RUN + FUTURE_SKEW_MS + 1)])).toBe('brewed_in_future');
  });
  it('the past and the run time itself count', () => {
    expect(only([brew('a', RUN)])).toBe('counted');
    expect(only([brew('a', RUN - DAY * 400)])).toBe('counted');
  });
});

describe('rule 4: brewed before the roast date', () => {
  const roast = entry({ roastDate: '2026-11-20' });
  it('the same UTC day counts, the last millisecond of the day before does not', () => {
    expect(only([brew('a', Date.UTC(2026, 10, 20, 0, 0, 0, 0))], roast)).toBe('counted');
    expect(only([brew('a', Date.UTC(2026, 10, 19, 23, 59, 59, 999))], roast)).toBe('brewed_before_roast');
  });
  it('uses the UTC day of the instant, whatever offset it was written with', () => {
    // 2026-11-20T01:00:00+02:00 is 2026-11-19T23:00:00Z: the day before.
    expect(only([brew('a', Date.parse('2026-11-20T01:00:00+02:00'))], roast)).toBe('brewed_before_roast');
    expect(only([brew('a', Date.parse('2026-11-19T23:00:00-02:00'))], roast)).toBe('counted');
  });
  it('an entry without a roast date is not judged by this rule', () => {
    expect(only([brew('a', Date.UTC(2001, 0, 1))], entry())).toBe('counted');
  });
});

describe('rule 5: burst', () => {
  it('5 brews in 60 s count, the 6th does not', () => {
    const v = verdicts(series(6, T0, SEC));
    expect(Object.values(v)).toEqual(['counted', 'counted', 'counted', 'counted', 'counted', 'burst']);
  });
  it('the window is sliding: 5 per 60 s at any offset, not per clock minute', () => {
    // Five brews at :50 to :54 of one minute, a sixth at :01 of the next: within 60 s of the first.
    const start = T0 + 50 * SEC;
    const v = verdicts([...series(5, start, SEC), brew('z', start + 11 * SEC)]);
    expect(v['u1/z']).toBe('burst');
  });
  it('the window is half open: a brew exactly one window after the first is outside it', () => {
    expect(only(series(5, T0, SEC).concat(brew('z', T0 + BURST_WINDOW_MS)))).toBe('counted');
    const v = verdicts([...series(5, T0, SEC), brew('z', T0 + BURST_WINDOW_MS - 1)]);
    expect(v['u1/z']).toBe('burst');
  });
  it('a steady rhythm of 5 per minute is not a burst', () => {
    const v = verdicts(series(DAILY_CAP, T0, BURST_WINDOW_MS / BURST_COUNT));
    expect(Object.values(v).every((x) => x === 'counted')).toBe(true);
  });
  it('rejected brews take no place in the window', () => {
    // 0..4 s count; 5 s and 6 s are bursts; at 60 s the window (0 s, 60 s] holds 4 kept brews: counted.
    const v = verdicts([...series(7, T0, SEC), brew('z', T0 + BURST_WINDOW_MS)]);
    expect(v['u1/p05']).toBe('burst');
    expect(v['u1/p06']).toBe('burst');
    expect(v['u1/z']).toBe('counted');
  });
  it('counts across beans and shelf entries of one user, never across users', () => {
    const entries = [entry(), entry({ shelfEntryId: 'e2', beanId: 'b2' }), entry({ userId: 'u2' })];
    const brews = [
      ...series(3, T0, SEC),
      ...series(3, T0 + 10 * SEC, SEC, { shelfEntryId: 'e2' }, 'q'),
      ...series(5, T0, SEC, { userId: 'u2' }, 'r'),
    ];
    const v = verdicts(brews, entries, consent('u1', 'u2'));
    expect(v['u1/q02']).toBe('burst');
    expect(Object.entries(v).filter(([k, x]) => k.startsWith('u2/') && x !== 'counted')).toEqual([]);
  });
});

describe('rule 6: bag dose over the bag weight', () => {
  const bag = entry({ bagGrams: 250 }); // limit 250 g x 1.10 = 275 g = 2750 dg
  const spaced = (doses: readonly number[]): PlausibilityBrew[] => doses.map((d, i) => brew(`d${String(i)}`, T0 + i * 10 * MIN, { doseDg: d }));

  it('the limit is the bag size times the margin', () => {
    expect(BAG_DOSE_MARGIN_PERCENT).toBe(110);
  });
  it('a running dose exactly at the limit counts, the next brew does not', () => {
    const v = verdicts(spaced([550, 550, 550, 550, 550, 1]), [bag]);
    expect(Object.values(v)).toEqual(['counted', 'counted', 'counted', 'counted', 'counted', 'bag_dose_exceeded']);
  });
  it('one decigram over the limit is rejected', () => {
    expect(Object.values(verdicts(spaced([2750, 1]), [bag]))).toEqual(['counted', 'bag_dose_exceeded']);
    expect(Object.values(verdicts(spaced([2751]), [bag]))).toEqual(['bag_dose_exceeded']);
  });
  it('a rejected brew adds nothing: a smaller later brew that still fits counts', () => {
    expect(Object.values(verdicts(spaced([2740, 20, 10]), [bag]))).toEqual(['counted', 'bag_dose_exceeded', 'counted']);
  });
  it('is oldest first, whatever the input order', () => {
    const brews = spaced([2740, 20]).reverse();
    expect(verdicts(brews, [bag])).toEqual({ 'u1/d0': 'counted', 'u1/d1': 'bag_dose_exceeded' });
  });
  it('each shelf entry has its own bag', () => {
    const entries = [bag, entry({ shelfEntryId: 'e2', bagGrams: 250 })];
    const brews = [brew('a', T0, { doseDg: 2750 }), brew('b', T0 + HOUR, { doseDg: 2750, shelfEntryId: 'e2' })];
    expect(Object.values(verdicts(brews, entries))).toEqual(['counted', 'counted']);
  });
  it('a bag without a known size is not judged by this rule', () => {
    const v = verdicts(spaced([1000, 1000, 1000, 1000]), [entry()]);
    expect(Object.values(v)).toEqual(['counted', 'counted', 'counted', 'counted']);
  });
  it('a brew without a dose is not judged and adds nothing', () => {
    const brews = [brew('a', T0), brew('b', T0 + HOUR, { doseDg: 2750 })];
    expect(Object.values(verdicts(brews, [bag]))).toEqual(['counted', 'counted']);
  });
});

describe('rule 7: straight-lining', () => {
  const nine = (value: number) => series(STRAIGHT_LINING_MIN_BREWS - 1, T0, 3 * HOUR, { scores: uniform(value) });
  it('9 identical brews count, 10 do not (all of them)', () => {
    expect(Object.values(verdicts(nine(8))).every((x) => x === 'counted')).toBe(true);
    const ten = [...nine(8), brew('z', T0 + 40 * HOUR, { scores: uniform(8) })];
    expect(Object.values(verdicts(ten)).every((x) => x === 'straight_lining')).toBe(true);
  });
  it('one differing score in one brew breaks it', () => {
    const differing = brew('z', T0 + 40 * HOUR, { scores: { ...uniform(8), body: 8.5 } });
    expect(Object.values(verdicts([...nine(8), differing])).every((x) => x === 'counted')).toBe(true);
  });
  it('brews that are each uniform but with different values are not straight-lining', () => {
    const brews = Array.from({ length: STRAIGHT_LINING_MIN_BREWS }, (_, i) => brew(`m${String(i)}`, T0 + i * 3 * HOUR, { scores: uniform(i % 2 === 0 ? 7 : 9) }));
    expect(Object.values(verdicts(brews)).every((x) => x === 'counted')).toBe(true);
  });
  it('is judged per user', () => {
    const entries = [entry(), entry({ userId: 'u2' })];
    const brews = [...series(STRAIGHT_LINING_MIN_BREWS, T0, 3 * HOUR, { scores: uniform(8) }), ...series(STRAIGHT_LINING_MIN_BREWS, T0, 3 * HOUR, { userId: 'u2' }, 'r')];
    const v = verdicts(brews, entries, consent('u1', 'u2'));
    expect(v['u1/p00']).toBe('straight_lining');
    expect(v['u2/r00']).toBe('counted');
  });
});

describe('rule 8: daily cap', () => {
  const cups = (n: number, over: Partial<PlausibilityBrew> = {}, prefix = 'c') => series(n, T0, 2 * MIN, over, prefix);
  it('the 10th cup of a day counts, the 11th does not', () => {
    const v = verdicts(cups(DAILY_CAP + 1));
    expect(Object.values(v).slice(0, DAILY_CAP).every((x) => x === 'counted')).toBe(true);
    expect(v[`u1/c${String(DAILY_CAP).padStart(2, '0')}`]).toBe('daily_cap_exceeded');
  });
  it('the first cups by brewedAt count, in any input order', () => {
    const v = verdicts(cups(DAILY_CAP + 3).reverse());
    expect(Object.entries(v).filter(([, x]) => x === 'daily_cap_exceeded').map(([k]) => k)).toEqual(['u1/c10', 'u1/c11', 'u1/c12']);
  });
  it('ties on brewedAt are broken by brew id', () => {
    const tied = [...cups(DAILY_CAP - 1), brew('zz', T0 + DAY / 4), brew('aa', T0 + DAY / 4)];
    const v = verdicts(tied);
    expect(v['u1/aa']).toBe('counted');
    expect(v['u1/zz']).toBe('daily_cap_exceeded');
  });
  it('the cap is per bean (two shelf entries of one bean share it) and per UTC day', () => {
    const entries = [entry(), entry({ shelfEntryId: 'e2' }), entry({ shelfEntryId: 'e3', beanId: 'b2' })];
    const brews = [...cups(6), ...series(6, T0 + HOUR, 2 * MIN, { shelfEntryId: 'e2' }, 'd'), ...series(6, T0 + 2 * HOUR, 2 * MIN, { shelfEntryId: 'e3' }, 'f')];
    const v = verdicts(brews, entries);
    expect(Object.entries(v).filter(([, x]) => x === 'daily_cap_exceeded').map(([k]) => k)).toEqual(['u1/d04', 'u1/d05']);
    // The next UTC day starts over.
    const midnight = Date.UTC(2026, 10, 21, 0, 0, 0);
    const split = [...series(DAILY_CAP, midnight - 20 * MIN, 2 * MIN), ...series(DAILY_CAP, midnight + 2 * MIN, 2 * MIN, {}, 'n')];
    expect(Object.values(verdicts(split)).every((x) => x === 'counted')).toBe(true);
  });
  it('cups rejected by an earlier rule take no place under the cap (the cap runs before n is computed)', () => {
    const rejectedEarlier = cups(5, { scores: undefined }, 'x');
    const v = verdicts([...rejectedEarlier, ...series(DAILY_CAP, T0 + HOUR, 2 * MIN, {}, 'y')]);
    expect(Object.values(v).filter((x) => x === 'counted')).toHaveLength(DAILY_CAP);
    expect(Object.values(v).filter((x) => x === 'unrated')).toHaveLength(5);
  });
});

describe('rule order: the first failing rule names the brew', () => {
  it('no consent beats unrated', () => {
    expect(only([brew('a', T0, { scores: undefined })], entry(), new Map())).toBe('no_consent');
  });
  it('unrated beats future', () => {
    expect(only([brew('a', RUN + DAY, { scores: undefined })])).toBe('unrated');
  });
  it('future beats before roast', () => {
    expect(only([brew('a', RUN + DAY)], entry({ roastDate: '2030-01-01' }))).toBe('brewed_in_future');
  });
  it('before roast beats burst (brews rejected earlier are not in the window)', () => {
    const v = verdicts(series(8, T0, SEC), [entry({ roastDate: '2030-01-01' })]);
    expect(new Set(Object.values(v))).toEqual(new Set(['brewed_before_roast']));
  });
  it('burst beats bag dose, and the dose rule only sees the brews that were not bursts', () => {
    // 6 brews 1 s apart, 600 dg each, 250 g bag (limit 2750 dg): the 5th would pass the limit, the 6th is a burst.
    const v = verdicts(series(6, T0, SEC, { doseDg: 600 }), [entry({ bagGrams: 250 })]);
    expect(Object.values(v)).toEqual(['counted', 'counted', 'counted', 'counted', 'bag_dose_exceeded', 'burst']);
  });
  it('bag dose beats straight-lining', () => {
    const brews = series(STRAIGHT_LINING_MIN_BREWS + 1, T0, 3 * HOUR, { scores: uniform(8), doseDg: 600 });
    const v = verdicts(brews, [entry({ bagGrams: 250 })]);
    // 4 brews fit (2400 dg); the 5th, 6th, ... would pass 2750 and are dose rejects; only 4 reach rule 7: below the minimum.
    expect(Object.values(v).filter((x) => x === 'counted')).toHaveLength(4);
    expect(Object.values(v).filter((x) => x === 'bag_dose_exceeded')).toHaveLength(STRAIGHT_LINING_MIN_BREWS - 3);
  });
  it('straight-lining beats the daily cap', () => {
    const v = verdicts(series(DAILY_CAP + 2, T0, 2 * MIN, { scores: uniform(8) }));
    expect(new Set(Object.values(v))).toEqual(new Set(['straight_lining']));
  });
});

describe('the contract and the judge agree', () => {
  const contract = JSON.parse(readFileSync(join(BACKEND_DIR, '..', 'contracts', 'aggregation', 'v1', 'reasons.json'), 'utf8')) as {
    reasons: { id: string }[];
  };
  const contractIds = contract.reasons.map((r) => r.id);

  it('the rules are exactly the contract ids, in the contract order', () => {
    expect(RULES.map((r) => r.reason)).toEqual(contractIds);
    expect([...REASON_IDS]).toEqual(contractIds);
  });

  /** One history in which every rule rejects at least one brew. */
  function everyReason(): { brews: PlausibilityBrew[]; entries: PlausibilityShelfEntry[]; consents: Map<string, boolean> } {
    const users = ['consent_no', 'rated_no', 'future', 'roast', 'burst', 'dose', 'line', 'cap', 'fine'];
    const entries = users.map((userId) => entry({ userId, bagGrams: 250, roastDate: userId === 'roast' ? '2026-11-25' : undefined }));
    const mk = (userId: string, rest: PlausibilityBrew[]) => rest.map((b) => ({ ...b, userId }));
    const brews = [
      ...mk('consent_no', series(1, T0, MIN)),
      ...mk('rated_no', series(1, T0, MIN, { scores: undefined })),
      ...mk('future', series(1, RUN + DAY, MIN)),
      ...mk('roast', series(1, T0, MIN)),
      ...mk('burst', series(BURST_COUNT + 1, T0, SEC)),
      ...mk('dose', series(2, T0, 10 * MIN, { doseDg: 2750 })),
      ...mk('line', series(STRAIGHT_LINING_MIN_BREWS, T0, 3 * HOUR, { scores: uniform(8) })),
      ...mk('cap', series(DAILY_CAP + 1, T0, 2 * MIN)),
      ...mk('fine', series(2, T0, 10 * MIN)),
    ];
    const consents = consent(...users.filter((u) => u !== 'consent_no'));
    return { brews, entries, consents };
  }

  it('every reason id of the contract is produced, and nothing else is', () => {
    const { brews, entries, consents } = everyReason();
    const emitted = new Set(judgeBrews(brews, entries, consents, RUN).verdicts.map((v) => v.verdict));
    expect(emitted).toEqual(new Set([...contractIds, 'counted']));
  });

  it('every verdict the judge emits is in the contract or is "counted"', () => {
    const { brews, entries, consents } = everyReason();
    for (const v of judgeBrews(brews, entries, consents, RUN).verdicts) expect([...contractIds, 'counted']).toContain(v.verdict);
  });
});

describe('orphan brews (shelf entry missing) never throw', () => {
  const orphan = (id: string, at: number) => brew(id, at, { shelfEntryId: 'missing' });
  it('an orphan of a consenting user is left out of every rule and only counted', () => {
    const r = judgeBrews([orphan('o', T0), brew('a', T0 + HOUR)], [entry()], consent('u1'), RUN);
    expect(r.verdicts).toEqual([{ userId: 'u1', brewId: 'a', verdict: 'counted' }]);
    expect(r.orphanBrews).toBe(1);
  });
  it('an orphan of a non-consenting user or a user without a profile is no_consent', () => {
    const r = judgeBrews([orphan('o', T0), { ...orphan('p', T0), userId: 'gone' }], [], new Map([['u1', false]]), RUN);
    expect(r.verdicts).toEqual([
      { userId: 'gone', brewId: 'p', verdict: 'no_consent' },
      { userId: 'u1', brewId: 'o', verdict: 'no_consent' },
    ]);
    expect(r.orphanBrews).toBe(0);
  });
  it("another user's shelf entry with the same id does not rescue an orphan", () => {
    const r = judgeBrews([brew('a', T0)], [entry({ userId: 'u2' })], consent('u1'), RUN);
    expect(r.verdicts).toEqual([]);
    expect(r.orphanBrews).toBe(1);
  });
  it('an orphan changes no other verdict (no burst place, no dose, no cap slot, no history)', () => {
    const base = series(STRAIGHT_LINING_MIN_BREWS - 1, T0, 3 * HOUR, { scores: uniform(8), doseDg: 250 });
    const orphans = Array.from({ length: 20 }, (_, i) => orphan(`o${String(i)}`, T0 + i * SEC));
    const bag = [entry({ bagGrams: 250 })];
    const withOrphans = judgeBrews([...base, ...orphans], bag, consent('u1'), RUN);
    expect(withOrphans.verdicts).toEqual(judgeBrews(base, bag, consent('u1'), RUN).verdicts);
    expect(withOrphans.orphanBrews).toBe(20);
  });
});

describe('input errors fail closed', () => {
  it('a repeated brew or shelf entry throws', () => {
    expect(() => judgeBrews([brew('a', T0), brew('a', T0 + HOUR)], [entry()], consent('u1'), RUN)).toThrow(PlausibilityInputError);
    expect(() => judgeBrews([brew('a', T0)], [entry(), entry()], consent('u1'), RUN)).toThrow(PlausibilityInputError);
  });
  it('an empty input gives an empty result', () => {
    expect(judgeBrews([], [], new Map(), RUN)).toEqual({ verdicts: [], orphanBrews: 0 });
  });
});

// A small seeded generator (mulberry32) so the property tests are reproducible.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface History {
  brews: PlausibilityBrew[];
  entries: PlausibilityShelfEntry[];
  consents: Map<string, boolean>;
}

function generate(seed: number): History {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const users = ['u1', 'u2', 'u3', 'u4'];
  const entries: PlausibilityShelfEntry[] = [];
  const brews: PlausibilityBrew[] = [];
  const consents = new Map<string, boolean>();
  for (const userId of users) {
    const c = r();
    if (c < 0.7) consents.set(userId, true);
    else if (c < 0.85) consents.set(userId, false);
    for (const [i, beanId] of ['b1', 'b2'].entries()) {
      const shelfEntryId = `e${String(i)}`;
      entries.push({
        userId,
        shelfEntryId,
        beanId,
        roastDate: r() < 0.4 ? `2026-11-${String(18 + Math.floor(r() * 4)).padStart(2, '0')}` : undefined,
        bagGrams: r() < 0.7 ? pick([250, 500]) : undefined,
      });
    }
    const straight = r() < 0.2;
    if (r() < 0.6) {
      const start = Date.UTC(2026, 10, 19, 8, Math.floor(r() * 50), 0);
      for (let k = 0; k < 8; k += 1) {
        brews.push({ userId, brewId: `${userId}-burst${String(k)}`, shelfEntryId: 'e0', brewedAtMs: start + k * 2000, scores: MIXED });
      }
    }
    const n = 5 + Math.floor(r() * 30);
    for (let k = 0; k < n; k += 1) {
      const bursty = r() < 0.4;
      const at = Date.UTC(2026, 10, 19 + Math.floor(r() * 2), Math.floor(r() * 24), Math.floor(r() * 60), bursty ? Math.floor(r() * 20) : Math.floor(r() * 60));
      const future = r() < 0.05;
      const scores = r() < 0.1 ? undefined : straight ? uniform(8) : { ...MIXED, aroma: pick([5, 6, 7, 8, 9]) };
      brews.push({
        userId,
        brewId: `${userId}-${String(k).padStart(3, '0')}`,
        shelfEntryId: `e${String(Math.floor(r() * 2))}`,
        brewedAtMs: future ? RUN + Math.floor(r() * 2 * HOUR) : at,
        doseDg: r() < 0.8 ? 150 + Math.floor(r() * 200) : undefined,
        scores,
      });
    }
  }
  return { brews, entries, consents };
}

const run = (h: History): BrewVerdict[] => [...judgeBrews(h.brews, h.entries, h.consents, RUN).verdicts];

function shuffled<T>(xs: readonly T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('determinism and order independence', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

  it('the generator exercises every reason', () => {
    const seen = new Set<string>();
    for (const seed of seeds) for (const v of run(generate(seed))) seen.add(v.verdict);
    expect(seen).toEqual(new Set([...REASON_IDS, 'counted']));
  });

  it.each(seeds)('seed %i: permuting brews, entries and consents gives identical verdicts', (seed) => {
    const h = generate(seed);
    const expected = run(h);
    const r = rng(seed * 7919);
    for (let round = 0; round < 5; round += 1) {
      const permuted: History = {
        brews: shuffled(h.brews, r),
        entries: shuffled(h.entries, r),
        consents: new Map(shuffled([...h.consents], r)),
      };
      expect(run(permuted)).toEqual(expected);
    }
    expect(run(h)).toEqual(expected);
  });

  it('every input brew gets exactly one verdict, sorted by user then brew id', () => {
    const h = generate(3);
    const out = run(h);
    expect(out).toHaveLength(h.brews.length);
    const keys = out.map((v) => `${v.userId}\u0000${v.brewId}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not modify its input', () => {
    const h = generate(5);
    const copy = structuredClone({ b: h.brews, e: h.entries, c: [...h.consents] });
    run(h);
    expect({ b: h.brews, e: h.entries, c: [...h.consents] }).toEqual(copy);
  });

  it('the run time is the only clock: the same input at another run time can differ, at the same one never', () => {
    const h = generate(9);
    expect(run(h)).toEqual(run(h));
    const later = [...judgeBrews(h.brews, h.entries, h.consents, RUN + 30 * DAY).verdicts];
    expect(later.filter((v) => v.verdict === 'brewed_in_future')).toEqual([]);
  });
});

describe('properties across generated histories', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
  const byKey = (vs: readonly BrewVerdict[]) => new Map(vs.map((v) => [`${v.userId}/${v.brewId}`, v.verdict]));

  it.each(seeds)('seed %i: flipping consent changes only that user', (seed) => {
    const h = generate(seed);
    const before = run(h);
    const flipped = new Map(h.consents);
    flipped.set('u2', flipped.get('u2') !== true);
    const after = [...judgeBrews(h.brews, h.entries, flipped, RUN).verdicts];
    for (const [i, v] of before.entries()) {
      if (v.userId !== 'u2') expect(after[i]).toEqual(v);
    }
  });

  it.each(seeds)('seed %i: removing a brew rejected by rules 1 to 5 changes no other verdict', (seed) => {
    const h = generate(seed);
    const before = byKey(run(h));
    for (const v of run(h)) {
      if (v.verdict === 'counted' || v.verdict === 'bag_dose_exceeded' || v.verdict === 'straight_lining' || v.verdict === 'daily_cap_exceeded') continue;
      const without = { ...h, brews: h.brews.filter((b) => !(b.userId === v.userId && b.brewId === v.brewId)) };
      const after = byKey(run(without));
      for (const [k, verdict] of after) expect(verdict).toBe(before.get(k));
    }
  });

  it('a bag-dose reject still holds a place in the burst window (rule 5 runs before rule 6)', () => {
    const a = brew('a', T0, { doseDg: 3000 });
    const rest = series(5, T0 + SEC, SEC, {}, 'r').map((b) => ({ ...b, shelfEntryId: 'e2' }));
    const entries = [entry({ bagGrams: 250 }), entry({ shelfEntryId: 'e2' })];
    const v = verdicts([a, ...rest], entries);
    expect(v['u1/a']).toBe('bag_dose_exceeded');
    expect(v['u1/r04']).toBe('burst');
    expect(verdicts(rest, entries)['u1/r04']).toBe('counted');
  });

  it('a cup over the daily cap still used the bag: removing it can change a later dose verdict (and nothing else)', () => {
    const bag = entry({ bagGrams: 250 });
    const cups = Array.from({ length: DAILY_CAP + 1 }, (_, i) => brew(`c${String(i).padStart(2, '0')}`, T0 + i * 2 * MIN, { doseDg: 250 }));
    // 11 x 250 dg = 2750 dg exactly: all within the bag, the 11th is only over the cap.
    expect(verdicts(cups, [bag])['u1/c10']).toBe('daily_cap_exceeded');
    const nextDay = brew('later', T0 + DAY, { doseDg: 1 });
    expect(verdicts([...cups, nextDay], [bag])['u1/later']).toBe('bag_dose_exceeded');
    expect(verdicts([...cups.slice(0, DAILY_CAP), nextDay], [bag])['u1/later']).toBe('counted');
  });

  it('removing a brew rejected by straight-lining can change the others (the rule judges the whole history)', () => {
    const ten = series(STRAIGHT_LINING_MIN_BREWS, T0, 3 * HOUR, { scores: uniform(8) });
    expect(new Set(Object.values(verdicts(ten)))).toEqual(new Set(['straight_lining']));
    expect(new Set(Object.values(verdicts(ten.slice(1))))).toEqual(new Set(['counted']));
  });

  it('removing a counted brew can change others through the rules that count (cap, burst, dose)', () => {
    const cap = series(DAILY_CAP + 1, T0, 2 * MIN);
    expect(verdicts(cap)['u1/p10']).toBe('daily_cap_exceeded');
    expect(verdicts(cap.slice(1))['u1/p10']).toBe('counted');

    const burstSet = series(BURST_COUNT + 1, T0, SEC);
    expect(verdicts(burstSet)['u1/p05']).toBe('burst');
    expect(verdicts(burstSet.slice(1))['u1/p05']).toBe('counted');

    const doses = [2750, 1].map((d, i) => brew(`d${String(i)}`, T0 + i * 10 * MIN, { doseDg: d }));
    expect(verdicts(doses, [entry({ bagGrams: 250 })])['u1/d1']).toBe('bag_dose_exceeded');
    expect(verdicts(doses.slice(1), [entry({ bagGrams: 250 })])['u1/d1']).toBe('counted');
  });
});

describe('thresholds come from config.ts', () => {
  const dir = join(BACKEND_DIR, 'src', 'aggregation', 'plausibility');
  const files = ['judge.ts', 'rules.ts', 'types.ts'];
  const code = (name: string): string =>
    readFileSync(join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");

  it.each(files)('%s has no numeric literal other than 0 and 1', (name) => {
    const literals = code(name).match(/(?<![\w$.])\d[\w.]*/g) ?? [];
    expect(literals.filter((l) => l !== '0' && l !== '1')).toEqual([]);
  });

  it('rules.ts imports every threshold it applies from ../config.ts and uses it', () => {
    const text = readFileSync(join(dir, 'rules.ts'), 'utf8');
    const imported = /import \{([^}]*)\} from '\.\.\/config\.ts'/.exec(text)?.[1] ?? '';
    const names = ['FUTURE_SKEW_MS', 'BURST_WINDOW_MS', 'BURST_COUNT', 'BAG_DOSE_MARGIN_PERCENT', 'STRAIGHT_LINING_MIN_BREWS', 'DAILY_CAP', 'DECIGRAMS_PER_GRAM', 'PERCENT_DENOMINATOR'];
    for (const name of names) {
      expect(imported).toContain(name);
      expect(code('rules.ts').split(name).length - 1).toBeGreaterThanOrEqual(1);
    }
    expect(code('rules.ts')).not.toMatch(/\b(?:const|let)\s+[A-Z_]{4,}\s*=\s*\d/);
  });

  it('the judge is pure: no clock, randomness, I/O or SDK in the module set', () => {
    for (const name of files) {
      const text = code(name);
      expect(text).not.toMatch(/\bDate\.now\b|new Date\s*\(\s*\)|\bperformance\b|Math\.random|\bprocess\b|node:|@aws-sdk|\bfetch\b|\bawait\b|\basync\b/);
      const imports = [...readFileSync(join(dir, name), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec).toMatch(/^\.{1,2}\//);
    }
  });

  it('never reads the reference recipes (ADR 0035 point 11)', () => {
    for (const name of files) expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(/contracts\/reference|reference\//);
  });

  it('the values the rules use are the ADR starting values', () => {
    expect([FUTURE_SKEW_MS, BURST_WINDOW_MS, BURST_COUNT, BAG_DOSE_MARGIN_PERCENT, STRAIGHT_LINING_MIN_BREWS, DAILY_CAP]).toEqual([300_000, 60_000, 5, 110, 10, 10]);
  });
});

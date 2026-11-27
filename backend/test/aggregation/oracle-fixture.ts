// The hand-computed oracle fixture of M3-T6 (ADR 0035): 8 users, 4 beans, 2 methods,
// 39 brews, and the expected aggregates and rankings worked out by hand. Every
// expected number below is derived in the comments from the brews listed here;
// none of them is the output of the code under test.
//
// Conventions. h = a score in half-points = 2 x points. L = 2520. A cup in a
// group of n counted cups weighs w = L / n. For an item: V = sum of w (weighted
// count), P = sum of w x h, Q = sum of w x h^2. Every brew is built with
// `rated(o)`, so its eight scores are, in half-points: aroma h - 2, acidity h - 1
// and the other six h (flavour, aftertaste, body, sweetness, balance, overall)
// where h = 2 x o. Hence, for an item with totals (V, P, Q):
//   six criteria:  weighted count V, sum P,         sum of squares Q
//   aroma:         weighted count V, sum P - 2V,    sum of squares Q - 4P + 4V   (since (h-2)^2 = h^2 - 4h + 4)
//   acidity:       weighted count V, sum P - V,     sum of squares Q - 2P + V    (since (h-1)^2 = h^2 - 2h + 1)
//
// Run time: 2026-11-27 12:00 UTC (the run day is 2026-11-27). Days below are November 2026.
import type { Method, PriceBand, Rating } from '../../src/generated/contract.ts';
import type { AggregateItem, Criterion, CriterionTotals, RankFacet, RankingItem, RebuildInput } from '../../src/aggregation/rebuild/types.ts';
import type { HistogramParameterId } from '../../src/generated/aggregation.ts';
import { bean, brew, entry, rated, RUN } from './rebuild-fixtures.ts';

const at = (day: number, hour: number, minute: number, second = 0): number => Date.UTC(2026, 10, day, hour, minute, second);
const X: PriceBand = 'from_15_to_30';
const Y: PriceBand = 'from_30_to_45';

const withRating = (o: number, extra: Omit<Rating, 'scores'> = {}): Rating => ({ ...rated(o), ...extra });

// ---- the history ----
//
// Users u1..u6 have consent. u7 has a profile with consent false. u8 has no profile.
//
// Beans: A (verified: washed, light, Sumatra), B (not verified; the picked attributes must be ignored),
// C (no META item at all), D (verified: natural, light, Ethiopia). Methods: v60 and espresso.
// Price bands: X = from_15_to_30, Y = from_30_to_45.

export const fixtureInput: RebuildInput = {
  consentByUser: new Map([
    ['u1', true],
    ['u2', true],
    ['u3', true],
    ['u4', true],
    ['u5', true],
    ['u6', true],
    ['u7', false],
  ]),
  runTimeMs: RUN,
  beans: [
    bean('beanA', { verified: true, operator_attributes: { process: 'washed', roast_level: 'light', origin: 'sumatra' } }),
    bean('beanB', { picked_attributes: { process: 'washed', roast_level: 'light', origin: 'ethiopia' } }),
    bean('beanD', { verified: true, operator_attributes: { process: 'natural', roast_level: 'light', origin: 'ethiopia' } }),
  ],
  shelfEntries: [
    // Bean A, price band X for everyone. u1's bag is 250 g (limit 250 x 10 x 110 / 100 = 2,750 dg). u6's bag was roasted on 2026-11-25.
    entry({ user: 'u1', id: 'a1', bean: 'beanA', priceBand: X, bagSize: 'g_250' }),
    entry({ user: 'u2', id: 'a2', bean: 'beanA', priceBand: X }),
    entry({ user: 'u3', id: 'a3', bean: 'beanA', priceBand: X }),
    entry({ user: 'u4', id: 'a4', bean: 'beanA', priceBand: X }),
    entry({ user: 'u5', id: 'a5', bean: 'beanA', priceBand: X }),
    entry({ user: 'u6', id: 'a6', bean: 'beanA', priceBand: X, roastDate: '2026-11-25' }),
    entry({ user: 'u7', id: 'a7', bean: 'beanA', priceBand: X }),
    entry({ user: 'u8', id: 'a8', bean: 'beanA', priceBand: X }),
    // Bean B, band X.
    ...[1, 2, 3, 4, 5].map((u) => entry({ user: `u${String(u)}`, id: `eb${String(u)}`, bean: 'beanB', priceBand: X })),
    // Bean C, no band.
    ...[3, 4, 5, 6].map((u) => entry({ user: `u${String(u)}`, id: `ec${String(u)}`, bean: 'beanC' })),
    // Bean D: u1 bought it twice, in band X and in band Y; u2 to u5 once, in band X.
    entry({ user: 'u1', id: 'ed1x', bean: 'beanD', priceBand: X }),
    entry({ user: 'u1', id: 'ed1y', bean: 'beanD', priceBand: Y }),
    ...[2, 3, 4, 5].map((u) => entry({ user: `u${String(u)}`, id: `ed${String(u)}`, bean: 'beanD', priceBand: X })),
  ],
  brews: [
    // ---- bean A ----
    brew({
      id: 'b01', user: 'u1', entry: 'a1', at: at(20, 9, 0), method: 'v60',
      parameters: { dose_dg: 900, water_g: 1350, water_temp_c: 94, brew_time_s: 150, grind_normalised: 6 },
      rating: withRating(5, { buy_again: true, flavour_notes: ['berry', 'cherry'], intensities: { acidity: 'high' } }),
    }),
    brew({
      id: 'b02', user: 'u1', entry: 'a1', at: at(20, 9, 10), method: 'v60',
      parameters: { dose_dg: 900, water_g: 1440, water_temp_c: 96, brew_time_s: 149, grind_normalised: 5.5 },
      rating: withRating(4, { intensities: { body: 'low' } }),
    }),
    brew({
      id: 'b03', user: 'u1', entry: 'a1', at: at(20, 9, 20), method: 'espresso',
      parameters: { dose_dg: 900, water_g: 500, water_temp_c: 93, brew_time_s: 28, grind_normalised: 2 },
      rating: withRating(10),
    }),
    // Third 900 dg on the same bag: running dose 1800 + 900 + 900 = 3,600 > 2,750: rejected as bag_dose_exceeded (the first three: 900, 1800, 2700 <= 2750).
    brew({ id: 'b04', user: 'u1', entry: 'a1', at: at(22, 9, 0), method: 'espresso', parameters: { dose_dg: 900 }, rating: withRating(9) }),
    brew({ id: 'b05', user: 'u2', entry: 'a2', at: at(20, 10, 0), method: 'v60', parameters: { dose_dg: 180, water_g: 300 }, rating: withRating(7, { buy_again: false, flavour_notes: ['berry'] }) }),
    brew({ id: 'b06', user: 'u2', entry: 'a2', at: at(20, 10, 30), method: 'v60', rating: withRating(9) }),
    brew({ id: 'b07', user: 'u3', entry: 'a3', at: at(21, 8, 0), method: 'espresso', rating: withRating(8, { buy_again: true, flavour_notes: ['plum'] }) }),
    brew({ id: 'b08', user: 'u3', entry: 'a3', at: at(22, 8, 0), method: 'v60', rating: withRating(7) }),
    brew({ id: 'b09', user: 'u4', entry: 'a4', at: at(21, 12, 0), method: 'v60', parameters: { grind_normalised: 6 }, rating: withRating(9, { intensities: { acidity: 'medium' } }) }),
    brew({ id: 'b10', user: 'u5', entry: 'a5', at: at(21, 12, 30), method: 'v60', rating: withRating(6) }),
    // Brewed on 2026-11-23, two days before the roast date 2026-11-25: brewed_before_roast. The next one (the 26th) counts.
    brew({ id: 'b11', user: 'u6', entry: 'a6', at: at(23, 10, 0), method: 'v60', rating: withRating(8) }),
    brew({ id: 'b12', user: 'u6', entry: 'a6', at: at(26, 10, 0), method: 'v60', rating: withRating(10) }),
    // u7 (consent false) and u8 (no profile): no_consent, three brews.
    brew({ id: 'b13', user: 'u7', entry: 'a7', at: at(20, 11, 0), method: 'v60', rating: withRating(10) }),
    brew({ id: 'b14', user: 'u7', entry: 'a7', at: at(21, 11, 0), method: 'v60', rating: withRating(10) }),
    brew({ id: 'b15', user: 'u8', entry: 'a8', at: at(20, 11, 0), method: 'v60', rating: withRating(2) }),
    // ---- bean B (one cup per user on the 20th; only u1 carries buy-again and only u2 an intensity) ----
    brew({ id: 'b16', user: 'u1', entry: 'eb1', at: at(20, 14, 0), method: 'v60', rating: withRating(8, { buy_again: true }) }),
    brew({ id: 'b17', user: 'u2', entry: 'eb2', at: at(20, 14, 10), method: 'v60', rating: withRating(7, { intensities: { body: 'high' } }) }),
    brew({ id: 'b18', user: 'u3', entry: 'eb3', at: at(20, 14, 20), method: 'v60', rating: withRating(8) }),
    brew({ id: 'b19', user: 'u4', entry: 'eb4', at: at(20, 14, 30), method: 'v60', rating: withRating(7) }),
    brew({ id: 'b20', user: 'u5', entry: 'eb5', at: at(20, 14, 40), method: 'v60', rating: withRating(7.5) }),
    brew({ id: 'b21', user: 'u2', entry: 'eb2', at: at(21, 14, 0), method: 'v60', rating: null }), // unrated
    // ---- bean C ----
    // u3: six espresso brews 10 s apart on the 22nd (a burst: the earliest 5 count, the 6th is rejected as burst).
    ...[6, 7, 8, 9, 10, 2].map((o, i) => brew({ id: `b${String(22 + i)}`, user: 'u3', entry: 'ec3', at: at(22, 15, 0, 10 * i), method: 'espresso', rating: withRating(o) })),
    brew({ id: 'b28', user: 'u4', entry: 'ec4', at: at(21, 16, 0), method: 'v60', rating: withRating(7) }),
    // 12:06 on the run day: more than 5 minutes after the run time 12:00: brewed_in_future.
    brew({ id: 'b29', user: 'u4', entry: 'ec4', at: at(27, 12, 6), method: 'v60', rating: withRating(9) }),
    brew({ id: 'b30', user: 'u5', entry: 'ec5', at: at(21, 16, 30), method: 'v60', rating: withRating(8) }),
    brew({ id: 'b31', user: 'u6', entry: 'ec6', at: at(21, 17, 0), method: 'v60', rating: withRating(5) }),
    // ---- bean D (all v60 on the 21st) ----
    brew({ id: 'b32', user: 'u1', entry: 'ed1x', at: at(21, 18, 0), method: 'v60', rating: withRating(10) }),
    brew({ id: 'b33', user: 'u1', entry: 'ed1x', at: at(21, 18, 10), method: 'v60', rating: withRating(10) }),
    brew({ id: 'b34', user: 'u1', entry: 'ed1y', at: at(21, 18, 20), method: 'v60', rating: withRating(2) }),
    ...[2, 3, 4, 5].map((u) => brew({ id: `b${String(33 + u)}`, user: `u${String(u)}`, entry: `ed${String(u)}`, at: at(21, 19, 0), method: 'v60', rating: withRating(7) })),
    // u5's brew points at a shelf entry that does not exist (an orphan): left out of every number, counted once.
    brew({ id: 'b39', user: 'u5', entry: 'gone', at: at(20, 20, 0), method: 'v60', rating: withRating(8) }),
  ],
};

// ---- expected output ----

export const RUN_DAY = '2026-11-27';

/** The eight criteria of an item from its totals (V, P, Q), by the formulas in the header comment. */
function criteriaOf(V: number, P: number, Q: number): Record<Criterion, CriterionTotals> {
  const plain = { weighted_count: V, sum: P, sum_of_squares: Q };
  return {
    aroma: { weighted_count: V, sum: P - 2 * V, sum_of_squares: Q - 4 * P + 4 * V },
    flavour: plain,
    aftertaste: plain,
    acidity: { weighted_count: V, sum: P - V, sum_of_squares: Q - 2 * P + V },
    body: plain,
    sweetness: plain,
    balance: plain,
    overall: plain,
  };
}

interface Spec {
  readonly bean: string;
  readonly method?: Method;
  readonly raters: number;
  readonly totals: readonly [V: number, P: number, Q: number];
  readonly parts?: Partial<Pick<AggregateItem, 'intensities' | 'notes' | 'buy_again' | 'histograms' | 'raters_by_part'>>;
}

function expectedItem(spec: Spec): AggregateItem {
  const [V, P, Q] = spec.totals;
  return {
    kind: spec.method === undefined ? 'all' : 'method',
    bean_id: spec.bean,
    ...(spec.method === undefined ? {} : { method: spec.method }),
    run_day: RUN_DAY,
    weight_denominator: 2520,
    raters: spec.raters,
    criteria: criteriaOf(V, P, Q),
    intensities: spec.parts?.intensities ?? {},
    notes: spec.parts?.notes ?? {},
    buy_again: spec.parts?.buy_again ?? { yes: 0, no: 0 },
    histograms: spec.parts?.histograms ?? {},
    raters_by_part: spec.parts?.raters_by_part ?? { buy_again: 0, notes: 0, intensities: {}, histograms: {} },
  };
}

// Counted cups (30 of the 39 brews). h = half-points. The weight of a cup is 2520 / n, n = counted cups of its group.
//
// BEAN A, bean level, groups (user, bean, UTC day):
//   u1, 20th: b01 (o 5, h 10), b02 (o 4, h 8), b03 (o 10, h 20); n = 3, w = 840.
//        P = 840 x (10 + 8 + 20) = 840 x 38 = 31,920;  Q = 840 x (100 + 64 + 400) = 840 x 564 = 473,760.
//        (b04 is rejected: bag_dose_exceeded.)
//   u2, 20th: b05 (h 14), b06 (h 18); n = 2, w = 1,260.
//        P = 1,260 x 32 = 40,320;  Q = 1,260 x (196 + 324) = 1,260 x 520 = 655,200.
//   u3, 21st: b07 (h 16), n = 1, w = 2,520:  P = 40,320;  Q = 2,520 x 256 = 645,120.
//   u3, 22nd: b08 (h 14), n = 1, w = 2,520:  P = 35,280;  Q = 2,520 x 196 = 493,920.
//   u4, 21st: b09 (h 18), n = 1:             P = 45,360;  Q = 2,520 x 324 = 816,480.
//   u5, 21st: b10 (h 12), n = 1:             P = 30,240;  Q = 2,520 x 144 = 362,880.
//   u6, 26th: b12 (h 20), n = 1:             P = 50,400;  Q = 2,520 x 400 = 1,008,000.  (b11 is brewed_before_roast.)
//   u7 and u8: no_consent.
//   Seven groups = seven votes: V = 7 x 2,520 = 17,640 (check: 3 x 840 + 2 x 1,260 + 5 x 2,520 = 2,520 + 2,520 + 12,600).
//   P = 31,920 + 40,320 + 40,320 + 35,280 + 45,360 + 30,240 + 50,400 = 273,840.
//   Q = 473,760 + 655,200 + 645,120 + 493,920 + 816,480 + 362,880 + 1,008,000 = 4,455,360.
//   Raters: u1 to u6 = 6.
// A, method v60 (groups (user, bean, method, day)):
//   u1: b01, b02 only (b03 is espresso): n = 2, w = 1,260: P = 1,260 x (10 + 8) = 22,680; Q = 1,260 x (100 + 64) = 206,640.
//   u2: n = 2 as above: 40,320 / 655,200.  u3 (22nd): 35,280 / 493,920.  u4: 45,360 / 816,480.  u5: 30,240 / 362,880.  u6: 50,400 / 1,008,000.
//   V = 6 votes x 2,520 = 15,120.  P = 22,680 + 40,320 + 35,280 + 45,360 + 30,240 + 50,400 = 224,280.
//   Q = 206,640 + 655,200 + 493,920 + 816,480 + 362,880 + 1,008,000 = 3,543,120.  Raters 6.
//   (u1's two v60 cups weigh 1,260 each, not the 840 of the bean level: the method level is its own group.)
// A, method espresso: u1 b03 (h 20, n = 1, w = 2,520): 50,400 / 1,008,000;  u3 b07 (h 16): 40,320 / 645,120.
//   V = 5,040.  P = 90,720.  Q = 1,653,120.  Raters 2.
//
// A, the parts. Weights at bean level / v60 level / espresso level:
//   buy-again:  b01 yes (u1: 840 / 1,260), b05 no (u2: 1,260 / 1,260), b07 yes (u3: 2,520 at bean level and espresso level).
//     all: yes 840 + 2,520 = 3,360, no 1,260;  v60: yes 1,260, no 1,260;  espresso: yes 2,520, no 0.
//     raters of buy-again: all 3 (u1, u2, u3); v60 2 (u1, u2); espresso 1 (u3).
//   notes: b01 berry + cherry, b05 berry, b07 plum.
//     all: berry 840 + 1,260 = 2,100, cherry 840, plum 2,520; v60: berry 1,260 + 1,260 = 2,520, cherry 1,260; espresso: plum 2,520.
//     raters of notes: all 3, v60 2, espresso 1.
//   intensities: b01 acidity high (u1), b02 body low (u1), b09 acidity medium (u4, w 2,520).
//     all: acidity high 840, medium 2,520, body low 840;  v60: acidity high 1,260, medium 2,520, body low 1,260;  espresso: none.
//     raters: acidity 2 (u1, u4), body 1 (u1) for all and v60.
//   histograms (contract edges; ratio is scaled by 10, i.e. 100 x water_g / dose_dg):
//     b01: ratio 100 x 1350 / 900 = 150 -> ratio_filter_from_150 (lower edge inclusive); temp 94 -> hot_from_94; time 150 s -> filter_from_150; grind 6 x 2 = 12 -> from_12.
//     b02: ratio 100 x 1440 / 900 = 160 -> ratio_filter_from_160; temp 96 -> hot_from_96; time 149 -> filter_from_120 (120 <= 149 < 150); grind 5.5 x 2 = 11 -> from_10.
//     b03 (espresso): ratio 100 x 500 / 900 = 55.6 -> ratio_espresso_from_40 (40 <= 55.6 < 60); temp 93 -> hot_from_92; time 28 -> espresso_from_25; grind 2 x 2 = 4 -> from_4.
//     b05: ratio 100 x 300 / 180 = 166.7 -> ratio_filter_from_160.   b09: grind 6 -> from_12.
//     all (bean level): ratio_filter_from_150 840; ratio_filter_from_160 840 + 1,260 = 2,100; ratio_espresso_from_40 840 (raters 2: u1, u2);
//        temp hot_from_92 840, hot_from_94 840, hot_from_96 840 (1 rater); time espresso_from_25 840, filter_from_120 840, filter_from_150 840 (1);
//        grind from_4 840, from_10 840, from_12 840 + 2,520 = 3,360 (2 raters: u1, u4).
//     v60: ratio 150: 1,260; ratio 160: 1,260 + 1,260 = 2,520 (2 raters); temp 94: 1,260, 96: 1,260; time 150: 1,260, 120: 1,260;
//        grind from_10 1,260, from_12 1,260 + 2,520 = 3,780 (2 raters).
//     espresso: ratio_espresso_from_40, hot_from_92, espresso_from_25, grind from_4: 2,520 each, 1 rater each.
//
// BEAN B (5 users, one cup each on the 20th, n = 1, w = 2,520): o = 8, 7, 8, 7, 7.5 -> h = 16, 14, 16, 14, 15.
//   P = 2,520 x (16 + 14 + 16 + 14 + 15) = 2,520 x 75 = 189,000.
//   Q = 2,520 x (256 + 196 + 256 + 196 + 225) = 2,520 x 1,129 = 2,845,080.   V = 5 x 2,520 = 12,600.  Raters 5.
//   (b21 is unrated.) Only u1 carries buy-again (yes 2,520, 1 rater), only u2 an intensity (body high 2,520, 1 rater).
//   B has one method, so the v60 item has the same numbers as the bean item.
//
// BEAN C (4 raters u3 to u6; no META item):
//   u3, 22nd: b22 to b26 (o 6, 7, 8, 9, 10; h 12, 14, 16, 18, 20), n = 5, w = 504; b27 (o 2) is rejected as burst (6th within 60 s).
//        P = 504 x 80 = 40,320;  Q = 504 x (144 + 196 + 256 + 324 + 400) = 504 x 1,320 = 665,280.
//   u4, 21st: b28 (o 7, h 14): 35,280 / 493,920.  (b29 is in the future.)
//   u5, 21st: b30 (o 8, h 16): 40,320 / 645,120.   u6, 21st: b31 (o 5, h 10): 25,200 / 252,000 (2,520 x 100).
//   V = 4 x 2,520 = 10,080.  P = 40,320 + 35,280 + 40,320 + 25,200 = 141,120.  Q = 665,280 + 493,920 + 645,120 + 252,000 = 2,056,320.
//   Method espresso: u3 only: V 2,520, P 40,320, Q 665,280, 1 rater.  Method v60: u4, u5, u6: V 7,560, P 100,800, Q 1,391,040, 3 raters.
//
// BEAN D (u1 to u5, all v60 on the 21st):
//   u1: b32 (o 10, h 20, band X), b33 (h 20, band X), b34 (o 2, h 4, band Y); bean level n = 3, w = 840:
//        P = 840 x 44 = 36,960;  Q = 840 x (400 + 400 + 16) = 840 x 816 = 685,440.
//   u2 to u5: o 7, h 14, n = 1: P = 35,280, Q = 493,920 each.
//   V = 3 x 840 + 4 x 2,520 = 12,600.  P = 36,960 + 141,120 = 178,080.  Q = 685,440 + 1,975,680 = 2,661,120.  Raters 5.
//   Only one method: the v60 item equals the bean item (u1's method group is the same three cups).

export const expectedAggregates: readonly AggregateItem[] = [
  expectedItem({
    bean: 'beanA',
    raters: 6,
    totals: [17_640, 273_840, 4_455_360],
    parts: {
      buy_again: { yes: 3360, no: 1260 },
      notes: { berry: 2100, cherry: 840, plum: 2520 },
      intensities: { acidity: { high: 840, medium: 2520 }, body: { low: 840 } },
      histograms: histogramsOf({
        ratio: { ratio_filter_from_150: 840, ratio_filter_from_160: 2100, ratio_espresso_from_40: 840 },
        grind_normalised: { grind_normalised_all_from_4: 840, grind_normalised_all_from_10: 840, grind_normalised_all_from_12: 3360 },
        water_temp_c: { water_temp_c_hot_from_92: 840, water_temp_c_hot_from_94: 840, water_temp_c_hot_from_96: 840 },
        brew_time_s: { brew_time_s_espresso_from_25: 840, brew_time_s_filter_from_120: 840, brew_time_s_filter_from_150: 840 },
      }),
      raters_by_part: { buy_again: 3, notes: 3, intensities: { acidity: 2, body: 1 }, histograms: { ratio: 2, grind_normalised: 2, water_temp_c: 1, brew_time_s: 1 } },
    },
  }),
  expectedItem({
    bean: 'beanA',
    method: 'espresso',
    raters: 2,
    totals: [5040, 90_720, 1_653_120],
    parts: {
      buy_again: { yes: 2520, no: 0 },
      notes: { plum: 2520 },
      histograms: histogramsOf({
        ratio: { ratio_espresso_from_40: 2520 },
        grind_normalised: { grind_normalised_all_from_4: 2520 },
        water_temp_c: { water_temp_c_hot_from_92: 2520 },
        brew_time_s: { brew_time_s_espresso_from_25: 2520 },
      }),
      raters_by_part: { buy_again: 1, notes: 1, intensities: {}, histograms: { ratio: 1, grind_normalised: 1, water_temp_c: 1, brew_time_s: 1 } },
    },
  }),
  expectedItem({
    bean: 'beanA',
    method: 'v60',
    raters: 6,
    totals: [15_120, 224_280, 3_543_120],
    parts: {
      buy_again: { yes: 1260, no: 1260 },
      notes: { berry: 2520, cherry: 1260 },
      intensities: { acidity: { high: 1260, medium: 2520 }, body: { low: 1260 } },
      histograms: histogramsOf({
        ratio: { ratio_filter_from_150: 1260, ratio_filter_from_160: 2520 },
        grind_normalised: { grind_normalised_all_from_10: 1260, grind_normalised_all_from_12: 3780 },
        water_temp_c: { water_temp_c_hot_from_94: 1260, water_temp_c_hot_from_96: 1260 },
        brew_time_s: { brew_time_s_filter_from_120: 1260, brew_time_s_filter_from_150: 1260 },
      }),
      raters_by_part: { buy_again: 2, notes: 2, intensities: { acidity: 2, body: 1 }, histograms: { ratio: 2, grind_normalised: 2, water_temp_c: 1, brew_time_s: 1 } },
    },
  }),
  ...(['all', 'v60'] as const).map((level) =>
    expectedItem({
      bean: 'beanB',
      ...(level === 'v60' ? { method: 'v60' as const } : {}),
      raters: 5,
      totals: [12_600, 189_000, 2_845_080],
      parts: {
        buy_again: { yes: 2520, no: 0 },
        intensities: { body: { high: 2520 } },
        raters_by_part: { buy_again: 1, notes: 0, intensities: { body: 1 }, histograms: {} },
      },
    }),
  ),
  expectedItem({ bean: 'beanC', raters: 4, totals: [10_080, 141_120, 2_056_320] }),
  expectedItem({ bean: 'beanC', method: 'espresso', raters: 1, totals: [2520, 40_320, 665_280] }),
  expectedItem({ bean: 'beanC', method: 'v60', raters: 3, totals: [7560, 100_800, 1_391_040] }),
  expectedItem({ bean: 'beanD', raters: 5, totals: [12_600, 178_080, 2_661_120] }),
  expectedItem({ bean: 'beanD', method: 'v60', raters: 5, totals: [12_600, 178_080, 2_661_120] }),
];

function histogramsOf(input: Partial<Record<HistogramParameterId, Record<string, number>>>): Partial<Record<HistogramParameterId, Record<string, number>>> {
  return input;
}

// Rankings. Only beans with at least 5 distinct raters IN THAT FACET, best mean of `overall` first (exact fractions, ties by bean id).
//
//   all:   A 273,840 / 17,640 = 15.52 (half-points),  B 189,000 / 12,600 = 15.00,  D 178,080 / 12,600 = 14.13.  C has 4 raters: not listed.
//          Cross-check A against B: 273,840 x 12,600 = 3,450,384,000 > 189,000 x 17,640 = 3,333,960,000.   -> [A, B, D]
//   method v60:  A 224,280 / 15,120 = 14.83,  B 15.00,  D 14.13.  C has 3 v60 raters: not listed.            -> [B, A, D]
//          (A leads at bean level but trails B in v60, because u1's two v60 cups weigh 1,260 each at the method level.
//           With the bean-level weights of 840 for u1's two v60 cups, A's v60 sums would be V = 12,600 + 1,680 = 14,280 and
//           P = 201,600 + 840 x 18 = 216,720, mean 15.18, ahead of B (15.00): a wrong method weight changes this order. The
//           test shows it with the oracle's deliberately wrong option.)
//   method espresso: A has 2 raters, C 1: no list.
//   price band X (from_15_to_30), groups (user, bean, band, day):
//          A: all its cups are in X, same groups as bean level: 15.52, 6 raters.
//          B: all in X: 15.00, 5 raters.
//          D: u1's two X cups are one group (n = 2, w = 1,260, h 20, 20): P = 1,260 x 40 = 50,400, Q = 1,260 x 800 = 1,008,000;
//             with u2 to u5 (35,280 each): V = 1,260 x 2 + 4 x 2,520 = 12,600, P = 50,400 + 141,120 = 191,520, mean 15.20, 5 raters.
//          -> [A, D, B]. D's bean-level mean is 14.13 and would trail B; its band mean 15.20 passes B. Weighing the band by the
//             bean-level groups (840 each) gives u1: P = 840 x 40 = 33,600, so P = 33,600 + 141,120 = 174,720 and
//             V = 1,680 + 10,080 = 11,760, mean 14.86: D would fall behind B. The oracle option shows this too.
//   price band Y (from_30_to_45): D has 1 rater (u1): no list.
//   process washed: A (verified).  B is not verified: its picked attributes are not used.  -> [A];  process natural: [D].
//   roast level light: A and D (verified), A first by the means above.                      -> [A, D]
//   origin: A's origin sumatra is a region of indonesia -> indonesia: [A];  D: ethiopia: [D].  B's picked ethiopia is ignored.
export const expectedRankings: readonly RankingItem[] = [
  rank({ kind: 'all' }, ['beanA', 'beanB', 'beanD']),
  rank({ kind: 'method', value: 'v60' }, ['beanB', 'beanA', 'beanD']),
  rank({ kind: 'origin', value: 'ethiopia' }, ['beanD']),
  rank({ kind: 'origin', value: 'indonesia' }, ['beanA']),
  rank({ kind: 'price_band', value: X }, ['beanA', 'beanD', 'beanB']),
  rank({ kind: 'process', value: 'natural' }, ['beanD']),
  rank({ kind: 'process', value: 'washed' }, ['beanA']),
  rank({ kind: 'roast_level', value: 'light' }, ['beanA', 'beanD']),
];

function rank(facet: RankFacet, beanIds: readonly string[]): RankingItem {
  return { facet, run_day: RUN_DAY, bean_ids: beanIds };
}

// Counts. 39 brews seen, from 8 users. Rejections: no_consent b13, b14, b15 (3); unrated b21; brewed_in_future b29; brewed_before_roast b11;
// burst b27; bag_dose_exceeded b04. The orphan b39 is counted apart. 39 - 3 - 1 - 1 - 1 - 1 - 1 - 1 = 30 counted.
// Beans with aggregates: A, B, C, D = 4. Beans ranked: A, B, D = 3.
export const expectedCounts = {
  users_seen: 8,
  brews_seen: 39,
  brews_counted: 30,
  brews_orphaned: 1,
  reasons: { no_consent: 3, unrated: 1, brewed_in_future: 1, brewed_before_roast: 1, burst: 1, bag_dose_exceeded: 1, straight_lining: 0, daily_cap_exceeded: 0 },
  beans_with_aggregates: 4,
  beans_ranked: 3,
} as const;

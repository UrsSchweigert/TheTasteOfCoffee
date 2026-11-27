// An INDEPENDENT oracle for the nightly rebuild (M3-T6, ADR 0035). It is slow and
// obviously correct on purpose: plain loops, no clever grouping, every sum a
// BigInt rational (a fraction of two BigInts), so a weight is the fraction 1/n
// and nothing is rounded until the sums are scaled by L at the very end.
//
// It shares NOTHING with src/aggregation/rebuild/ or src/aggregation/plausibility/
// and does not use src/aggregation/arithmetic.ts. It reads only constants
// (src/aggregation/config.ts) and the contract data (generated vocabulary facts,
// histogram buckets, reason ids). Types are imported as types only.
import { HISTOGRAM_PARAMETERS, HISTOGRAM_PARAMETER_IDS, REASON_IDS, type HistogramParameterId, type ReasonId } from '../../../src/generated/aggregation.ts';
import { OriginSchema } from '../../../src/generated/contract.ts';
import type { Bean, Brew, FlavourNote, IntensityLevel, Method, PriceBand, ShelfEntry } from '../../../src/generated/contract.ts';
import { BAG_SIZE_GRAMS, ORIGIN_COUNTRY } from '../../../src/generated/vocabulary-facts.ts';
import {
  BAG_DOSE_MARGIN_PERCENT,
  BURST_COUNT,
  BURST_WINDOW_MS,
  DAILY_CAP,
  DECIGRAMS_PER_GRAM,
  FUTURE_SKEW_MS,
  MIN_RATERS,
  PERCENT_DENOMINATOR,
  STRAIGHT_LINING_MIN_BREWS,
  WEIGHT_DENOMINATOR,
} from '../../../src/aggregation/config.ts';
import type { AggregateItem, Criterion, CriterionTotals, IntensityDimension, RankFacet, RankingItem, RebuildInput, RebuildResult } from '../../../src/aggregation/rebuild/types.ts';

// ---- BigInt rationals ----

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function rat(n: bigint, d = 1n): Rat {
  if (d === 0n) throw new Error('zero denominator');
  const g = gcd(n, d);
  const sign = d < 0n ? -1n : 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
}

const ZERO = rat(0n);
const add = (a: Rat, b: Rat): Rat => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
/** Negative, zero or positive as a is below, equal to or above b. */
export function compareRat(a: Rat, b: Rat): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `r x L` as a number; throws if it is not a whole number or not a safe integer (that would be a bug in the weights, not a rounding). */
function scaled(r: Rat): number {
  const product = r.n * BigInt(WEIGHT_DENOMINATOR);
  if (product % r.d !== 0n) throw new Error('a sum is not a whole number after scaling by L');
  const value = product / r.d;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('a sum is not a safe integer');
  return Number(value);
}

// ---- decoding (the oracle's own) ----

const CRITERIA: readonly Criterion[] = ['aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall'];
const DIMENSIONS: readonly IntensityDimension[] = ['acidity', 'body', 'bitterness'];
/** Attribute values that name nothing and get no ranking (ADR 0035 point 14). */
const NO_RANKING: readonly string[] = ['other', 'unknown'];

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A number that is a whole multiple of 0.5 as a rational. */
function toRat(value: number): Rat {
  if (Number.isInteger(value)) return rat(BigInt(value));
  if (Number.isInteger(value * 2)) return rat(BigInt(value * 2), 2n);
  throw new Error('a value is off the half-step grid');
}

/** The bucket id of one parameter, found with rational comparisons; undefined if the cup lacks the field or the method has no set. */
function bucketId(parameter: HistogramParameterId, brew: Brew): string | undefined {
  const { parameters } = brew.values;
  const definition = HISTOGRAM_PARAMETERS[parameter];
  const set = definition.sets.find((candidate) => candidate.methods.includes(parameters.method));
  if (!set) return undefined;
  let value: Rat;
  if (parameter === 'ratio') {
    const { water_g: water, dose_dg: dose } = parameters;
    if (water === undefined || dose === undefined) return undefined;
    // ratio = water_g / (dose_dg / 10 g) = 10 x water_g / dose_dg; scaled by the contract's scale.
    value = mul(rat(BigInt(definition.scale)), rat(BigInt(DECIGRAMS_PER_GRAM) * BigInt(water), BigInt(dose)));
  } else {
    const raw = parameter === 'grind_normalised' ? parameters.grind_normalised : parameter === 'water_temp_c' ? parameters.water_temp_c : parameters.brew_time_s;
    if (raw === undefined) return undefined;
    value = mul(rat(BigInt(definition.scale)), toRat(raw));
  }
  for (const bucket of set.buckets) {
    if (compareRat(rat(BigInt(bucket.from)), value) <= 0 && compareRat(value, rat(BigInt(bucket.to))) < 0) return bucket.id;
  }
  return undefined;
}

interface Row {
  readonly user: string;
  readonly brew: Brew;
  readonly entry: ShelfEntry | undefined;
  readonly ms: number;
  readonly day: string;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Oldest first, then brew id, then user id. */
function compareRows(a: Row, b: Row): number {
  return a.ms - b.ms || compareText(a.brew.brew_id, b.brew.brew_id) || compareText(a.user, b.user);
}

const same = (a: readonly unknown[]): boolean => a.every((x) => x === a[0]);

// ---- the plausibility rules, in the order of ADR 0035 point 4, as plain loops ----

type Rule = (live: readonly Row[], input: RebuildInput) => Row[];

const RULE_LIST: readonly (readonly [ReasonId, Rule])[] = [
  ['no_consent', (live, input) => live.filter((row) => input.consentByUser.get(row.user) !== true)],
  ['unrated', (live) => live.filter((row) => row.brew.values.rating === undefined)],
  ['brewed_in_future', (live, input) => live.filter((row) => row.ms > input.runTimeMs + FUTURE_SKEW_MS)],
  ['brewed_before_roast', (live) => live.filter((row) => row.entry?.values.roast_date !== undefined && row.day < row.entry.values.roast_date)],
  [
    'burst',
    (live) => {
      const kept: Row[] = [];
      const rejected: Row[] = [];
      for (const row of live) {
        let inWindow = 0;
        for (const other of kept) if (other.user === row.user && other.ms > row.ms - BURST_WINDOW_MS) inWindow += 1;
        if (inWindow >= BURST_COUNT) rejected.push(row);
        else kept.push(row);
      }
      return rejected;
    },
  ],
  [
    'bag_dose_exceeded',
    (live) => {
      const running = new Map<string, bigint>();
      const rejected: Row[] = [];
      for (const row of live) {
        const { entry } = row;
        const dose = row.brew.values.parameters.dose_dg;
        const size = entry?.values.bag_size;
        const grams = entry && size ? BAG_SIZE_GRAMS[entry.values.vocabulary_version]?.[size] : undefined;
        if (grams === undefined || dose === undefined) continue;
        const key = `${row.user}|${row.brew.values.shelf_entry_id}`;
        const total = (running.get(key) ?? 0n) + BigInt(dose);
        // total (dg) must not exceed grams x 10 dg/g x 110 / 100
        if (total * BigInt(PERCENT_DENOMINATOR) > BigInt(grams) * BigInt(DECIGRAMS_PER_GRAM) * BigInt(BAG_DOSE_MARGIN_PERCENT)) rejected.push(row);
        else running.set(key, total);
      }
      return rejected;
    },
  ],
  [
    'straight_lining',
    (live) => {
      const rejected: Row[] = [];
      for (const user of new Set(live.map((row) => row.user))) {
        const mine = live.filter((row) => row.user === user);
        if (mine.length < STRAIGHT_LINING_MIN_BREWS) continue;
        const values = mine.flatMap((row) => CRITERIA.map((c) => row.brew.values.rating?.scores[c]));
        if (same(values)) rejected.push(...mine);
      }
      return rejected;
    },
  ],
  [
    'daily_cap_exceeded',
    (live) => {
      const rejected: Row[] = [];
      for (let i = 0; i < live.length; i += 1) {
        const row = live[i];
        if (!row) continue;
        let earlier = 0;
        for (let j = 0; j < i; j += 1) {
          const other = live[j];
          if (other?.user === row.user && other.day === row.day && other.entry?.values.bean_id === row.entry?.values.bean_id) earlier += 1;
        }
        if (earlier >= DAILY_CAP) rejected.push(row);
      }
      return rejected;
    },
  ],
];

// ---- weighted items ----

interface Cup {
  readonly row: Row;
  readonly user: string;
  readonly bean: string;
  readonly method: Method;
  readonly day: string;
  readonly band: PriceBand | undefined;
  readonly half: Readonly<Record<Criterion, number>>;
}

class Item {
  readonly raters = new Set<string>();
  votes = ZERO;
  readonly sum = Object.fromEntries(CRITERIA.map((c) => [c, ZERO])) as Record<Criterion, Rat>;
  readonly squares = Object.fromEntries(CRITERIA.map((c) => [c, ZERO])) as Record<Criterion, Rat>;
  readonly levels = new Map<string, Rat>();
  readonly levelRaters = new Map<string, Set<string>>();
  readonly notes = new Map<string, Rat>();
  readonly noteRaters = new Set<string>();
  yes = ZERO;
  no = ZERO;
  readonly buyRaters = new Set<string>();
  readonly buckets = new Map<string, Rat>();
  readonly bucketRaters = new Map<string, Set<string>>();

  add(cup: Cup, weight: Rat): void {
    const { brew } = cup.row;
    const rating = brew.values.rating;
    this.raters.add(cup.user);
    this.votes = add(this.votes, weight);
    for (const c of CRITERIA) {
      const h = rat(BigInt(cup.half[c]));
      this.sum[c] = add(this.sum[c], mul(weight, h));
      this.squares[c] = add(this.squares[c], mul(weight, mul(h, h)));
    }
    for (const dimension of DIMENSIONS) {
      const level = rating?.intensities?.[dimension];
      if (level === undefined) continue;
      const key = `${dimension}|${level}`;
      this.levels.set(key, add(this.levels.get(key) ?? ZERO, weight));
      this.levelRaters.set(dimension, (this.levelRaters.get(dimension) ?? new Set<string>()).add(cup.user));
    }
    const notes = rating?.flavour_notes ?? [];
    for (const note of notes) this.notes.set(note, add(this.notes.get(note) ?? ZERO, weight));
    if (notes.length > 0) this.noteRaters.add(cup.user);
    if (rating?.buy_again !== undefined) {
      if (rating.buy_again) this.yes = add(this.yes, weight);
      else this.no = add(this.no, weight);
      this.buyRaters.add(cup.user);
    }
    for (const parameter of HISTOGRAM_PARAMETER_IDS) {
      const id = bucketId(parameter, brew);
      if (id === undefined) continue;
      this.buckets.set(id, add(this.buckets.get(id) ?? ZERO, weight));
      this.bucketRaters.set(parameter, (this.bucketRaters.get(parameter) ?? new Set<string>()).add(cup.user));
    }
  }

  mean(criterion: Criterion): Rat {
    return rat(this.sum[criterion].n * this.votes.d, this.sum[criterion].d * this.votes.n);
  }

  toItem(bean: string, method: Method | undefined, runDay: string): AggregateItem {
    const criteria = Object.fromEntries(
      CRITERIA.map((c): [Criterion, CriterionTotals] => [c, { weighted_count: scaled(this.votes), sum: scaled(this.sum[c]), sum_of_squares: scaled(this.squares[c]) }]),
    ) as Record<Criterion, CriterionTotals>;

    const intensities: Partial<Record<IntensityDimension, Partial<Record<IntensityLevel, number>>>> = {};
    for (const [key, weight] of this.levels) {
      const [dimension, level] = key.split('|') as [IntensityDimension, IntensityLevel];
      intensities[dimension] = { ...intensities[dimension], [level]: scaled(weight) };
    }
    const notes: Partial<Record<FlavourNote, number>> = {};
    for (const [note, weight] of this.notes) notes[note as FlavourNote] = scaled(weight);

    const histograms: Partial<Record<HistogramParameterId, Record<string, number>>> = {};
    const histogramRaters: Partial<Record<HistogramParameterId, number>> = {};
    for (const parameter of HISTOGRAM_PARAMETER_IDS) {
      const ids = HISTOGRAM_PARAMETERS[parameter].sets.flatMap((set) => set.buckets.map((b) => b.id));
      const present = ids.filter((id) => this.buckets.has(id));
      if (present.length === 0) continue;
      histograms[parameter] = Object.fromEntries(present.map((id) => [id, scaled(this.buckets.get(id) ?? ZERO)]));
      histogramRaters[parameter] = this.bucketRaters.get(parameter)?.size ?? 0;
    }
    const intensityRaters: Partial<Record<IntensityDimension, number>> = {};
    for (const dimension of DIMENSIONS) {
      const set = this.levelRaters.get(dimension);
      if (set) intensityRaters[dimension] = set.size;
    }

    return {
      kind: method === undefined ? 'all' : 'method',
      bean_id: bean,
      ...(method === undefined ? {} : { method }),
      run_day: runDay,
      weight_denominator: WEIGHT_DENOMINATOR,
      raters: this.raters.size,
      criteria,
      intensities,
      notes,
      buy_again: { yes: scaled(this.yes), no: scaled(this.no) },
      histograms,
      raters_by_part: { buy_again: this.buyRaters.size, notes: this.noteRaters.size, intensities: intensityRaters, histograms: histogramRaters },
    };
  }
}

/**
 * Builds the items of one level. A group is the cups sharing `groupKey`; every
 * cup of a group of n weighs the fraction 1/n. Cups for which `itemKey` returns
 * undefined are left out of this level.
 */
function buildLevel(cups: readonly Cup[], itemKey: (cup: Cup) => string | undefined, groupKey: (cup: Cup) => string): Map<string, Item> {
  const items = new Map<string, Item>();
  const keys = cups.map((cup) => ({ item: itemKey(cup), group: groupKey(cup) }));
  cups.forEach((cup, i) => {
    const mine = keys[i];
    if (mine?.item === undefined) return;
    let size = 0;
    for (const other of keys) if (other.item !== undefined && other.group === mine.group) size += 1;
    let item = items.get(mine.item);
    if (!item) {
      item = new Item();
      items.set(mine.item, item);
    }
    item.add(cup, rat(1n, BigInt(size)));
  });
  return items;
}

const SEP = '\u0001';

export interface OracleOptions {
  /** Deliberately wrong weight groups, to show that a fixture can tell them apart. The default is the rule of ADR 0035 point 3. */
  readonly methodWeights?: 'method' | 'bean';
  readonly bandWeights?: 'band' | 'bean';
}

export type OracleVerdict = 'counted' | ReasonId | 'orphan';

export interface OracleAnalysis {
  readonly result: RebuildResult;
  /** Verdict per brew, keyed by `user` + SEP + `brew id`. */
  readonly verdicts: ReadonlyMap<string, OracleVerdict>;
  /** The rational mean of every criterion of every item, keyed by bean id or bean id + SEP + method. */
  readonly means: ReadonlyMap<string, Readonly<Record<Criterion, Rat>>>;
  /** The number of one-vote groups of every item (a whole number), same keys. */
  readonly votes: ReadonlyMap<string, bigint>;
}

export const verdictKey = (user: string, brewId: string): string => user + SEP + brewId;

export function analyse(input: RebuildInput, options: OracleOptions = {}): OracleAnalysis {
  const runDay = dayOf(input.runTimeMs);

  // Rows: every brew with its shelf entry found by a plain search.
  const rows: Row[] = input.brews.map(({ userId, brew }) => {
    const found = input.shelfEntries.find((e) => e.userId === userId && e.entry.shelf_entry_id === brew.values.shelf_entry_id);
    const ms = Date.parse(brew.values.brewed_at);
    return { user: userId, brew, entry: found?.entry, ms, day: dayOf(ms) };
  });

  const verdicts = new Map<string, OracleVerdict>();
  const reasons = Object.fromEntries(REASON_IDS.map((id) => [id, 0])) as Record<ReasonId, number>;
  let orphans = 0;
  const judged: Row[] = [];
  for (const row of rows) {
    if (row.entry) judged.push(row);
    else if (input.consentByUser.get(row.user) !== true) {
      verdicts.set(verdictKey(row.user, row.brew.brew_id), 'no_consent');
      reasons.no_consent += 1;
    } else {
      verdicts.set(verdictKey(row.user, row.brew.brew_id), 'orphan');
      orphans += 1;
    }
  }

  let live = [...judged].sort(compareRows);
  for (const [reason, rule] of RULE_LIST) {
    const rejected = rule(live, input);
    for (const row of rejected) {
      verdicts.set(verdictKey(row.user, row.brew.brew_id), reason);
      reasons[reason] += 1;
    }
    live = live.filter((row) => !rejected.includes(row));
  }

  const cups: Cup[] = live.map((row) => {
    const scores = row.brew.values.rating?.scores;
    if (!scores || !row.entry) throw new Error('a counted brew without scores or shelf entry');
    const half = Object.fromEntries(CRITERIA.map((c) => [c, scores[c] * 2])) as Record<Criterion, number>;
    return { row, user: row.user, bean: row.entry.values.bean_id, method: row.brew.values.parameters.method, day: row.day, band: row.entry.values.price_band, half };
  });
  for (const cup of cups) verdicts.set(verdictKey(cup.user, cup.row.brew.brew_id), 'counted');

  // Levels.
  const allLevel = buildLevel(cups, (c) => c.bean, (c) => [c.user, c.bean, c.day].join(SEP));
  const methodLevel = buildLevel(
    cups,
    (c) => c.bean + SEP + c.method,
    options.methodWeights === 'bean' ? (c) => [c.user, c.bean, c.day].join(SEP) : (c) => [c.user, c.bean, c.method, c.day].join(SEP),
  );
  const bandLevel = buildLevel(
    cups,
    (c) => (c.band === undefined ? undefined : c.bean + SEP + c.band),
    options.bandWeights === 'bean' ? (c) => [c.user, c.bean, c.day].join(SEP) : (c) => [c.user, c.bean, c.band ?? '', c.day].join(SEP),
  );

  const aggregates: AggregateItem[] = [];
  const means = new Map<string, Record<Criterion, Rat>>();
  const votes = new Map<string, bigint>();
  const keep = (key: string, item: Item): void => {
    means.set(key, Object.fromEntries(CRITERIA.map((c) => [c, item.mean(c)])) as Record<Criterion, Rat>);
    // Votes are whole with the right weight groups; deliberately wrong groups (OracleOptions) may give fractions, which are not recorded.
    if (item.votes.d === 1n) votes.set(key, item.votes.n);
  };
  for (const [bean, item] of allLevel) {
    aggregates.push(item.toItem(bean, undefined, runDay));
    keep(bean, item);
  }
  for (const [key, item] of methodLevel) {
    const [bean = '', method = ''] = key.split(SEP);
    aggregates.push(item.toItem(bean, method as Method, runDay));
    keep(key, item);
  }
  aggregates.sort((a, b) => compareText(a.bean_id, b.bean_id) || compareText(a.method ?? '', b.method ?? ''));

  // Rankings.
  const lists = new Map<string, { facet: RankFacet; candidates: { bean: string; item: Item }[] }>();
  const offer = (facet: RankFacet, bean: string, item: Item): void => {
    if (item.raters.size < MIN_RATERS) return;
    const id = 'value' in facet ? `${facet.kind}/${facet.value}` : facet.kind;
    const list = lists.get(id) ?? { facet, candidates: [] };
    list.candidates.push({ bean, item });
    lists.set(id, list);
  };
  const beanMeta = (id: string): Bean | undefined => input.beans.find((b) => b.bean_id === id);
  for (const [bean, item] of allLevel) {
    offer({ kind: 'all' }, bean, item);
    const meta = beanMeta(bean);
    if (!meta?.verified) continue;
    const { process, roast_level: roast, origin } = meta.operator_attributes;
    if (process !== undefined && !NO_RANKING.includes(process)) offer({ kind: 'process', value: process }, bean, item);
    if (roast !== undefined && !NO_RANKING.includes(roast)) offer({ kind: 'roast_level', value: roast }, bean, item);
    const country = origin === undefined ? undefined : ORIGIN_COUNTRY[meta.vocabulary_version]?.[origin];
    if (country !== undefined) offer({ kind: 'origin', value: OriginSchema.parse(country) }, bean, item);
  }
  for (const [key, item] of methodLevel) {
    const [bean = '', method = ''] = key.split(SEP);
    offer({ kind: 'method', value: method as Method }, bean, item);
  }
  for (const [key, item] of bandLevel) {
    const [bean = '', band = ''] = key.split(SEP);
    offer({ kind: 'price_band', value: band as PriceBand }, bean, item);
  }
  const rankings: RankingItem[] = [...lists.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, { facet, candidates }]) => ({
      facet,
      run_day: runDay,
      bean_ids: [...candidates].sort((a, b) => compareRat(b.item.mean('overall'), a.item.mean('overall')) || compareText(a.bean, b.bean)).map((c) => c.bean),
    }));

  return {
    result: {
      aggregates,
      rankings,
      counts: {
        users_seen: new Set(rows.map((r) => r.user)).size,
        brews_seen: rows.length,
        brews_counted: cups.length,
        brews_orphaned: orphans,
        reasons,
        beans_with_aggregates: allLevel.size,
        beans_ranked: new Set(rankings.flatMap((r) => r.bean_ids)).size,
      },
    },
    verdicts,
    means,
    votes,
  };
}

/** The oracle's answer for a history. */
export function oracle(input: RebuildInput, options: OracleOptions = {}): RebuildResult {
  return analyse(input, options).result;
}

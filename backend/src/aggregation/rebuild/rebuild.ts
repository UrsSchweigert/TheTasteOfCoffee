// The rebuild core (ADR 0035, M3-T5): pure. It turns the scanned data into the
// complete desired set of aggregate and ranking items plus the run's counts.
// No I/O, no clock (the run time is a parameter), no randomness, no reading of
// contracts/reference (ADR 0034). Same input in any order gives the same output.
//
// Steps: decode at one boundary (timestamps, half-points, bag grams), judge
// every brew (M3-T4), weigh the counted cups (L / n per group, exact integers),
// add them to the bean and bean-and-method items, then rank.
import { REASON_IDS, type ReasonId } from '../../generated/aggregation.ts';
import { ORIGIN_COUNTRY, BAG_SIZE_GRAMS } from '../../generated/vocabulary-facts.ts';
import { OriginSchema, TimestampSchema } from '../../generated/contract.ts';
import type { Bean, Brew, Method, PriceBand, ShelfEntry } from '../../generated/contract.ts';
import { utcDay } from '../age.ts';
import { MIN_RATERS, HALF_POINTS_PER_POINT, MAX_HALF_POINTS, MIN_HALF_POINTS } from '../config.ts';
import { weightOf } from '../arithmetic.ts';
import { judgeBrews } from '../plausibility/judge.ts';
import type { PlausibilityBrew, PlausibilityShelfEntry } from '../plausibility/types.ts';
import { bucketsOf } from './buckets.ts';
import { CRITERIA, INTENSITY_DIMENSIONS, ItemBuilder, type CountedCup } from './item-builder.ts';
import { RebuildInputError, type AggregateItem, type Criterion, type RankFacet, type RankingItem, type RebuildInput, type RebuildResult } from './types.ts';

const SEPARATOR = '\u0000';
const key = (...parts: readonly string[]): string => parts.join(SEPARATOR);

/** Attribute ids that name no value: they get no ranking (ADR 0035 point 14). The catch-all ids of NON_PARENT_IDS in contracts/lib/vocabulary.mjs (a .mjs the typed backend does not import); a test pins that they agree. Origins that name no place are already left out of ORIGIN_COUNTRY. */
const UNRANKED_ATTRIBUTES: ReadonlySet<string> = new Set(['other', 'unknown']);

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// ---- boundary: decode once ----

/** `brewed_at` as epoch milliseconds, decoded through the contract schema. A value that does not decode fails the run. */
function decodeTimestamp(value: string): number {
  const parsed = TimestampSchema.safeParse(value);
  const ms = parsed.success ? Date.parse(parsed.data) : Number.NaN;
  if (!Number.isFinite(ms)) throw new RebuildInputError('a brew has a timestamp that does not decode');
  return ms;
}

/** The eight scores as integer half-points; the only place where points become half-points. */
function decodeHalfPoints(brew: Brew): Record<Criterion, number> | undefined {
  const scores = brew.values.rating?.scores;
  if (!scores) return undefined;
  const result = {} as Record<Criterion, number>;
  for (const criterion of CRITERIA) {
    const halfPoints = scores[criterion] * HALF_POINTS_PER_POINT;
    if (!Number.isInteger(halfPoints) || halfPoints < MIN_HALF_POINTS || halfPoints > MAX_HALF_POINTS) throw new RebuildInputError('a score is off the half-point grid');
    result[criterion] = halfPoints;
  }
  return result;
}

/** The bag size in grams from the shelf entry's own vocabulary version; unknown means not judged by rule 6. */
function bagGramsOf(entry: ShelfEntry): number | undefined {
  const { vocabulary_version: version, bag_size: size } = entry.values;
  return size === undefined ? undefined : BAG_SIZE_GRAMS[version]?.[size];
}

interface Decoded {
  readonly userId: string;
  readonly brew: Brew;
  readonly brewedAtMs: number;
  readonly halfPoints: Record<Criterion, number> | undefined;
}

// ---- ranking ----

interface Candidate {
  readonly beanId: string;
  readonly sum: number;
  readonly weightedCount: number;
}

/** Higher mean of `overall` first, compared exactly by cross-multiplication in BigInt; ties by bean id. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const left = BigInt(a.sum) * BigInt(b.weightedCount);
  const right = BigInt(b.sum) * BigInt(a.weightedCount);
  if (left !== right) return left > right ? -1 : 1;
  return compareText(a.beanId, b.beanId);
}

const facetKey = (facet: RankFacet): string => ('value' in facet ? `${facet.kind}/${facet.value}` : facet.kind);

class Rankings {
  readonly #lists = new Map<string, { facet: RankFacet; candidates: Candidate[] }>();

  /** A bean takes part in a facet only with at least the minimum distinct raters in that facet's own count. */
  offer(facet: RankFacet, beanId: string, builder: ItemBuilder): void {
    if (builder.raters < MIN_RATERS) return;
    const { sum, weightedCount } = builder.totals('overall');
    const id = facetKey(facet);
    let list = this.#lists.get(id);
    if (!list) {
      list = { facet, candidates: [] };
      this.#lists.set(id, list);
    }
    list.candidates.push({ beanId, sum, weightedCount });
  }

  items(runDay: string): RankingItem[] {
    return [...this.#lists.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([, { facet, candidates }]) => ({ facet, run_day: runDay, bean_ids: candidates.sort(compareCandidates).map((c) => c.beanId) }));
  }
}

/** Verified beans only: the operator's attributes place a bean in the process, roast level and origin lists. */
function attributeFacets(bean: Bean | undefined): RankFacet[] {
  if (!bean?.verified) return [];
  const { process, roast_level: roast, origin } = bean.operator_attributes;
  const facets: RankFacet[] = [];
  if (process !== undefined && !UNRANKED_ATTRIBUTES.has(process)) facets.push({ kind: 'process', value: process });
  if (roast !== undefined && !UNRANKED_ATTRIBUTES.has(roast)) facets.push({ kind: 'roast_level', value: roast });
  if (origin !== undefined) {
    const country = ORIGIN_COUNTRY[bean.vocabulary_version]?.[origin];
    if (country !== undefined) facets.push({ kind: 'origin', value: OriginSchema.parse(country) });
  }
  return facets;
}

// ---- the rebuild ----

export function rebuild(input: RebuildInput): RebuildResult {
  if (!Number.isFinite(input.runTimeMs)) throw new RebuildInputError('the run time is not a number');
  const runDay = utcDay(input.runTimeMs);

  const beans = new Map<string, Bean>();
  for (const bean of input.beans) {
    if (beans.has(bean.bean_id)) throw new RebuildInputError('a bean appears twice');
    beans.set(bean.bean_id, bean);
  }

  const decoded: Decoded[] = input.brews.map(({ userId, brew }) => ({
    userId,
    brew,
    brewedAtMs: decodeTimestamp(brew.values.brewed_at),
    halfPoints: decodeHalfPoints(brew),
  }));

  const usersSeen = new Set(decoded.map((d) => d.userId)).size;

  const shelfByKey = new Map<string, ShelfEntry>();
  const plausibilityEntries: PlausibilityShelfEntry[] = input.shelfEntries.map(({ userId, entry }) => {
    shelfByKey.set(key(userId, entry.shelf_entry_id), entry);
    return {
      userId,
      shelfEntryId: entry.shelf_entry_id,
      beanId: entry.values.bean_id,
      roastDate: entry.values.roast_date,
      bagGrams: bagGramsOf(entry),
    };
  });
  const plausibilityBrews: PlausibilityBrew[] = decoded.map(({ userId, brew, brewedAtMs }) => ({
    userId,
    brewId: brew.brew_id,
    shelfEntryId: brew.values.shelf_entry_id,
    brewedAtMs,
    doseDg: brew.values.parameters.dose_dg,
    scores: brew.values.rating?.scores,
  }));

  const { verdicts, orphanBrews } = judgeBrews(plausibilityBrews, plausibilityEntries, input.consentByUser, input.runTimeMs);

  const reasons = Object.fromEntries(REASON_IDS.map((id) => [id, 0])) as Record<ReasonId, number>;
  const verdictOf = new Map<string, string>();
  for (const { userId, brewId, verdict } of verdicts) {
    verdictOf.set(key(userId, brewId), verdict);
    if (verdict !== 'counted') reasons[verdict] += 1;
  }

  const cups: CountedCup[] = [];
  for (const item of decoded) {
    if (verdictOf.get(key(item.userId, item.brew.brew_id)) !== 'counted') continue;
    const entry = shelfByKey.get(key(item.userId, item.brew.values.shelf_entry_id));
    const { halfPoints } = item;
    if (!entry || !halfPoints) throw new RebuildInputError('a counted brew has no shelf entry or no scores');
    const { rating, parameters } = item.brew.values;
    cups.push({
      userId: item.userId,
      beanId: entry.values.bean_id,
      method: parameters.method,
      day: utcDay(item.brewedAtMs),
      priceBand: entry.values.price_band,
      halfPoints,
      intensities: Object.fromEntries(INTENSITY_DIMENSIONS.flatMap((d) => (rating?.intensities?.[d] === undefined ? [] : [[d, rating.intensities[d]]]))),
      notes: rating?.flavour_notes ?? [],
      buyAgain: rating?.buy_again,
      buckets: bucketsOf(parameters),
    });
  }

  // Group sizes. The cap (rule 8) is already applied, so n is at most the cap and weightOf accepts it.
  const sizes = new Map<string, number>();
  const count = (k: string): void => void sizes.set(k, (sizes.get(k) ?? 0) + 1);
  const allKey = (c: CountedCup): string => key('all', c.userId, c.beanId, c.day);
  const methodKey = (c: CountedCup): string => key('method', c.userId, c.beanId, c.method, c.day);
  const bandKey = (c: CountedCup): string => key('band', c.userId, c.beanId, c.priceBand ?? '', c.day);
  for (const cup of cups) {
    count(allKey(cup));
    count(methodKey(cup));
    if (cup.priceBand !== undefined) count(bandKey(cup));
  }
  const weight = (k: string): number => weightOf(sizes.get(k) ?? 0);

  const allBuilders = new Map<string, ItemBuilder>();
  const methodBuilders = new Map<string, { beanId: string; method: Method; builder: ItemBuilder }>();
  const bandBuilders = new Map<string, { beanId: string; band: PriceBand; builder: ItemBuilder }>();
  const builderFor = <T>(map: Map<string, T>, k: string, make: () => T): T => {
    let found = map.get(k);
    if (!found) {
      found = make();
      map.set(k, found);
    }
    return found;
  };
  for (const cup of cups) {
    builderFor(allBuilders, cup.beanId, () => new ItemBuilder()).add(cup, weight(allKey(cup)));
    builderFor(methodBuilders, key(cup.beanId, cup.method), () => ({ beanId: cup.beanId, method: cup.method, builder: new ItemBuilder() })).builder.add(cup, weight(methodKey(cup)));
    if (cup.priceBand !== undefined) {
      const band = cup.priceBand;
      builderFor(bandBuilders, key(cup.beanId, band), () => ({ beanId: cup.beanId, band, builder: new ItemBuilder() })).builder.add(cup, weight(bandKey(cup)));
    }
  }

  const aggregates: AggregateItem[] = [
    ...[...allBuilders.entries()].map(([beanId, builder]) => builder.toItem(beanId, undefined, runDay)),
    ...[...methodBuilders.values()].map(({ beanId, method, builder }) => builder.toItem(beanId, method, runDay)),
  ].sort((a, b) => compareText(a.bean_id, b.bean_id) || compareText(a.method ?? '', b.method ?? ''));

  const rankings = new Rankings();
  for (const [beanId, builder] of allBuilders) {
    rankings.offer({ kind: 'all' }, beanId, builder);
    for (const facet of attributeFacets(beans.get(beanId))) rankings.offer(facet, beanId, builder);
  }
  for (const { beanId, method, builder } of methodBuilders.values()) rankings.offer({ kind: 'method', value: method }, beanId, builder);
  for (const { beanId, band, builder } of bandBuilders.values()) rankings.offer({ kind: 'price_band', value: band }, beanId, builder);
  const rankingItems = rankings.items(runDay);

  return {
    aggregates,
    rankings: rankingItems,
    counts: {
      users_seen: usersSeen,
      brews_seen: decoded.length,
      brews_counted: cups.length,
      brews_orphaned: orphanBrews,
      reasons,
      beans_with_aggregates: allBuilders.size,
      beans_ranked: new Set(rankingItems.flatMap((r) => r.bean_ids)).size,
    },
  };
}

// `readAggregate`: the one function that returns aggregate data (ADR 0035
// point 10, CLAUDE.md invariant 4). A structural test pins that nothing else
// reads aggregate keys.
//
// What it does, in this order:
// 1. reads the one item (`AGG#ALL` or `AGG#METHOD#<method>` of the bean);
// 2. no item, or fewer than MIN_RATERS distinct raters: "not enough raters", and
//    nothing else (no count, no sum, no run day). An absent bean and a bean
//    below the threshold look the same;
// 3. an item older than MAX_AGE_DAYS by the rule of age.ts: "not available";
// 4. otherwise only derived figures: rounded mean and spread per criterion and
//    shares in whole percent. Never a raw sum, a sum of squares or a weighted
//    count. Each optional part whose own distinct-rater count is below
//    MIN_RATERS is left out and the rest is returned.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isServable, utcDay } from '../aggregation/age.ts';
import { meanPointsTenths, spreadPointsTenths } from '../aggregation/arithmetic.ts';
import { MIN_RATERS, WEIGHT_DENOMINATOR } from '../aggregation/config.ts';
import { CRITERIA, INTENSITY_DIMENSIONS } from '../aggregation/rebuild/item-builder.ts';
import type { AggregateItem, Criterion, IntensityDimension } from '../aggregation/rebuild/types.ts';
import type { HistogramParameterId } from '../generated/aggregation.ts';
import { HISTOGRAM_PARAMETER_IDS } from '../generated/aggregation.ts';
import type { FlavourNote, IntensityLevel, Method } from '../generated/contract.ts';
import { decodeStoredAggregate } from './aggregate-schemas.ts';
import { CorruptItemError } from './errors.ts';
import { aggregateAllKey, aggregateMethodKey, parseAggregateSortKey, parseBeanPk } from './keys.ts';
import { AggregationArithmeticError } from '../aggregation/arithmetic.ts';

/** Mean and spread of one criterion on the 0 to 10 scale, in tenths of a point (`75` is 7.5). */
export interface CriterionFigures {
  readonly mean_tenths: number;
  readonly spread_tenths: number;
}

/** Everything a paid route may show of one item. Whole percents are rounded half up and need not add up to 100. */
export interface ServedAggregate {
  /** UTC day of the run the numbers come from (they are up to a day old; the app says so). */
  readonly run_day: string;
  /** Distinct raters, at least MIN_RATERS. */
  readonly raters: number;
  readonly criteria: Readonly<Record<Criterion, CriterionFigures>>;
  /** Share of cups that carry buy-again and said yes. Left out below MIN_RATERS raters of this part. */
  readonly buy_again_yes_percent?: number;
  /** Per dimension (only those with enough raters of their own): share of cups at each level. */
  readonly intensities?: Readonly<Partial<Record<IntensityDimension, Readonly<Partial<Record<IntensityLevel, number>>>>>>;
  /** Share of all counted cups that carry the note. Left out below MIN_RATERS raters of notes. */
  readonly notes?: Readonly<Partial<Record<FlavourNote, number>>>;
  /** Per parameter (only those with enough raters of their own): share of cups in each bucket. */
  readonly histograms?: Readonly<Partial<Record<HistogramParameterId, Readonly<Record<string, number>>>>>;
}

export type AggregateRead =
  /** No item, or fewer than MIN_RATERS distinct raters. Carries nothing. */
  | { readonly kind: 'not_enough_raters' }
  /** The item is older than MAX_AGE_DAYS (or stamped in the future). Carries nothing. */
  | { readonly kind: 'not_available' }
  | { readonly kind: 'served'; readonly aggregate: ServedAggregate };

/** `100 x part / whole` in whole percent, rounded half up, in BigInt so no product can lose precision. */
function percent(part: number, whole: number): number {
  if (whole <= 0) throw new CorruptItemError('a stored aggregate has an empty denominator');
  return Number((200n * BigInt(part) + BigInt(whole)) / (2n * BigInt(whole)));
}

function sumOf(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Derives what may be served from a decoded item. Pure. */
function serveFrom(item: AggregateItem): ServedAggregate {
  if (item.weight_denominator !== WEIGHT_DENOMINATOR) throw new CorruptItemError('a stored aggregate has another weight denominator');
  const criteria = {} as Record<Criterion, CriterionFigures>;
  for (const criterion of CRITERIA) {
    const totals = item.criteria[criterion];
    const asTotals = { weightedCount: totals.weighted_count, sum: totals.sum, sumOfSquares: totals.sum_of_squares };
    try {
      criteria[criterion] = { mean_tenths: meanPointsTenths(asTotals), spread_tenths: spreadPointsTenths(asTotals) };
    } catch (error) {
      if (error instanceof AggregationArithmeticError) throw new CorruptItemError('a stored aggregate has inconsistent totals', { cause: error });
      throw error;
    }
  }
  const everyCup = item.criteria.overall.weighted_count;
  const parts = item.raters_by_part;

  let buyAgain: number | undefined;
  const asked = item.buy_again.yes + item.buy_again.no;
  if (parts.buy_again >= MIN_RATERS && asked > 0) buyAgain = percent(item.buy_again.yes, asked);

  const intensities: Partial<Record<IntensityDimension, Partial<Record<IntensityLevel, number>>>> = {};
  for (const dimension of INTENSITY_DIMENSIONS) {
    const levels = item.intensities[dimension];
    if ((parts.intensities[dimension] ?? 0) < MIN_RATERS || levels === undefined) continue;
    const whole = sumOf(Object.values(levels));
    if (whole === 0) continue;
    intensities[dimension] = Object.fromEntries(Object.entries(levels).map(([level, count]) => [level, percent(count, whole)]));
  }

  let notes: Partial<Record<FlavourNote, number>> | undefined;
  if (parts.notes >= MIN_RATERS) {
    notes = Object.fromEntries(Object.entries(item.notes).map(([note, count]) => [note, percent(count, everyCup)]));
  }

  const histograms: Partial<Record<HistogramParameterId, Record<string, number>>> = {};
  for (const parameter of HISTOGRAM_PARAMETER_IDS) {
    const buckets = item.histograms[parameter];
    if ((parts.histograms[parameter] ?? 0) < MIN_RATERS || buckets === undefined) continue;
    const whole = sumOf(Object.values(buckets));
    if (whole === 0) continue;
    histograms[parameter] = Object.fromEntries(Object.entries(buckets).map(([bucket, count]) => [bucket, percent(count, whole)]));
  }

  return {
    run_day: item.run_day,
    raters: item.raters,
    criteria,
    ...(buyAgain === undefined ? {} : { buy_again_yes_percent: buyAgain }),
    ...(Object.keys(intensities).length === 0 ? {} : { intensities }),
    ...(notes === undefined || Object.keys(notes).length === 0 ? {} : { notes }),
    ...(Object.keys(histograms).length === 0 ? {} : { histograms }),
  };
}

/**
 * The aggregate of one bean (all methods) or of one bean and method, behind the
 * 5-rater threshold. `now` is the read time (injected for tests).
 */
export async function readAggregate(client: DynamoDBDocumentClient, table: string, now: Date, beanId: string, method?: Method): Promise<AggregateRead> {
  const key = method === undefined ? aggregateAllKey(beanId) : aggregateMethodKey(beanId, method);
  const result = await client.send(new GetCommand({ TableName: table, Key: key }));
  if (result.Item === undefined) return { kind: 'not_enough_raters' };
  const decoded = decodeStoredAggregate(result.Item);
  const kind = parseAggregateSortKey(key.sk);
  if (
    decoded === undefined ||
    kind === undefined ||
    decoded.pk !== key.pk ||
    decoded.sk !== key.sk ||
    parseBeanPk(key.pk) !== decoded.body.bean_id ||
    decoded.body.kind !== kind.kind ||
    decoded.body.method !== (kind.kind === 'method' ? kind.method : undefined)
  ) {
    throw new CorruptItemError('a stored aggregate does not match its schema or its key');
  }
  const item = decoded.body;
  // The threshold comes first: below it the answer carries nothing, not even the age.
  if (item.raters < MIN_RATERS) return { kind: 'not_enough_raters' };
  if (!isServable(item.run_day, utcDay(now.getTime()))) return { kind: 'not_available' };
  return { kind: 'served', aggregate: serveFrom(item) };
}

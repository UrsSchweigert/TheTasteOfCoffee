// Accumulates counted cups into one aggregate item (ADR 0035 point 3). Every sum
// goes through the checked arithmetic of ../arithmetic.ts, so an unsafe integer
// fails the run. The builder remembers the distinct users per part as sets of
// ids in memory only; the item it emits holds numbers, never a user id.
import { HISTOGRAM_PARAMETER_IDS, type HistogramParameterId } from '../../generated/aggregation.ts';
import { FlavourNoteSchema, IntensityLevelSchema, ScoresSchema, IntensitiesSchema } from '../../generated/contract.ts';
import type { FlavourNote, IntensityLevel, Method, PriceBand } from '../../generated/contract.ts';
import { WEIGHT_DENOMINATOR } from '../config.ts';
import { addWeight, WeightedAccumulator } from '../arithmetic.ts';
import { BUCKET_IDS } from './buckets.ts';
import type { AggregateItem, Criterion, CriterionTotals, IntensityDimension } from './types.ts';

export const CRITERIA: readonly Criterion[] = ScoresSchema.keyof().options;
export const INTENSITY_DIMENSIONS: readonly IntensityDimension[] = IntensitiesSchema.keyof().options;
const INTENSITY_LEVELS: readonly IntensityLevel[] = IntensityLevelSchema.options;
const FLAVOUR_NOTES: readonly FlavourNote[] = FlavourNoteSchema.options;

/** One counted cup, decoded once: everything the builders need, no I/O types. */
export interface CountedCup {
  readonly userId: string;
  readonly beanId: string;
  readonly method: Method;
  /** UTC day of `brewedAt`. */
  readonly day: string;
  readonly priceBand: PriceBand | undefined;
  readonly halfPoints: Readonly<Record<Criterion, number>>;
  readonly intensities: Readonly<Partial<Record<IntensityDimension, IntensityLevel>>>;
  readonly notes: readonly FlavourNote[];
  readonly buyAgain: boolean | undefined;
  readonly buckets: readonly (readonly [HistogramParameterId, string])[];
}

function bump<K>(map: Map<K, number>, key: K, weight: number): void {
  map.set(key, addWeight(map.get(key) ?? 0, weight));
}

function users<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

export class ItemBuilder {
  readonly #criteria = new Map<Criterion, WeightedAccumulator>(CRITERIA.map((c) => [c, new WeightedAccumulator()]));
  readonly #raters = new Set<string>();
  readonly #intensities = new Map<string, number>();
  readonly #intensityRaters = new Map<IntensityDimension, Set<string>>();
  readonly #notes = new Map<FlavourNote, number>();
  readonly #noteRaters = new Set<string>();
  #buyYes = 0;
  #buyNo = 0;
  readonly #buyRaters = new Set<string>();
  readonly #histograms = new Map<string, number>();
  readonly #histogramRaters = new Map<HistogramParameterId, Set<string>>();

  /** Adds one counted cup with its weight `L / n` (from `weightOf`). */
  add(cup: CountedCup, weight: number): void {
    for (const criterion of CRITERIA) this.#criteria.get(criterion)?.add(weight, cup.halfPoints[criterion]);
    this.#raters.add(cup.userId);
    for (const dimension of INTENSITY_DIMENSIONS) {
      const level = cup.intensities[dimension];
      if (level === undefined) continue;
      bump(this.#intensities, `${dimension}/${level}`, weight);
      users(this.#intensityRaters, dimension).add(cup.userId);
    }
    if (cup.notes.length > 0) {
      for (const note of cup.notes) bump(this.#notes, note, weight);
      this.#noteRaters.add(cup.userId);
    }
    if (cup.buyAgain !== undefined) {
      if (cup.buyAgain) this.#buyYes = addWeight(this.#buyYes, weight);
      else this.#buyNo = addWeight(this.#buyNo, weight);
      this.#buyRaters.add(cup.userId);
    }
    for (const [parameter, bucket] of cup.buckets) {
      bump(this.#histograms, bucket, weight);
      users(this.#histogramRaters, parameter).add(cup.userId);
    }
  }

  get raters(): number {
    return this.#raters.size;
  }

  /** The totals of one criterion (the ranking orders by `overall`). */
  totals(criterion: Criterion): WeightedAccumulator['totals'] {
    const accumulator = this.#criteria.get(criterion);
    if (!accumulator) throw new Error('unknown criterion');
    return accumulator.totals;
  }

  /** The item, with every map in the fixed order of the contract and zero entries left out. */
  toItem(beanId: string, method: Method | undefined, runDay: string): AggregateItem {
    const criteria = Object.fromEntries(
      CRITERIA.map((criterion): [Criterion, CriterionTotals] => {
        const totals = this.totals(criterion);
        return [criterion, { weighted_count: totals.weightedCount, sum: totals.sum, sum_of_squares: totals.sumOfSquares }];
      }),
    ) as Record<Criterion, CriterionTotals>;

    const intensities: Partial<Record<IntensityDimension, Partial<Record<IntensityLevel, number>>>> = {};
    for (const dimension of INTENSITY_DIMENSIONS) {
      const levels: Partial<Record<IntensityLevel, number>> = {};
      for (const level of INTENSITY_LEVELS) {
        const count = this.#intensities.get(`${dimension}/${level}`);
        if (count !== undefined) levels[level] = count;
      }
      if (Object.keys(levels).length > 0) intensities[dimension] = levels;
    }

    const notes: Partial<Record<FlavourNote, number>> = {};
    for (const note of FLAVOUR_NOTES) {
      const count = this.#notes.get(note);
      if (count !== undefined) notes[note] = count;
    }

    const histograms: Partial<Record<HistogramParameterId, Record<string, number>>> = {};
    const histogramRaters: Partial<Record<HistogramParameterId, number>> = {};
    for (const parameter of HISTOGRAM_PARAMETER_IDS) {
      const buckets: Record<string, number> = {};
      for (const bucket of BUCKET_IDS[parameter]) {
        const count = this.#histograms.get(bucket);
        if (count !== undefined) buckets[bucket] = count;
      }
      if (Object.keys(buckets).length > 0) {
        histograms[parameter] = buckets;
        histogramRaters[parameter] = this.#histogramRaters.get(parameter)?.size ?? 0;
      }
    }

    const intensityRaters: Partial<Record<IntensityDimension, number>> = {};
    for (const dimension of INTENSITY_DIMENSIONS) {
      const set = this.#intensityRaters.get(dimension);
      if (set) intensityRaters[dimension] = set.size;
    }

    return {
      kind: method === undefined ? 'all' : 'method',
      bean_id: beanId,
      ...(method === undefined ? {} : { method }),
      run_day: runDay,
      weight_denominator: WEIGHT_DENOMINATOR,
      raters: this.#raters.size,
      criteria,
      intensities,
      notes,
      buy_again: { yes: this.#buyYes, no: this.#buyNo },
      histograms,
      raters_by_part: { buy_again: this.#buyRaters.size, notes: this.#noteRaters.size, intensities: intensityRaters, histograms: histogramRaters },
    };
  }
}

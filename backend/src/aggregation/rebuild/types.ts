// Inputs and outputs of the rebuild core (ADR 0035, M3-T5). Plain data, no I/O
// types: the repository (M3-T7) decodes scanned items into the inputs and maps
// the outputs to keys. Output attribute names are the snake_case names of
// contracts/README.md (Aggregate item shapes). No output holds a user id.
import type { HistogramParameterId, ReasonId } from '../../generated/aggregation.ts';
import type { Bean, FlavourNote, Intensities, IntensityLevel, Method, Origin, PriceBand, Process, RoastLevel, Scores, ShelfEntry, Brew } from '../../generated/contract.ts';

export type Criterion = keyof Scores;
export type IntensityDimension = keyof Intensities;

/** A decoded brew item and the user whose partition it was in (the user id comes from the key, never from the item body). */
export interface RebuildBrew {
  readonly userId: string;
  readonly brew: Brew;
}

export interface RebuildShelfEntry {
  readonly userId: string;
  readonly entry: ShelfEntry;
}

export interface RebuildInput {
  readonly brews: readonly RebuildBrew[];
  readonly shelfEntries: readonly RebuildShelfEntry[];
  /** Bean `META` items. A bean that is missing here still gets its aggregates, but no attribute facet. */
  readonly beans: readonly Bean[];
  /** `consent.contribute_to_aggregates` per user; a user without an entry has no consent. */
  readonly consentByUser: ReadonlyMap<string, boolean>;
  /** The run's single clock read, epoch milliseconds. */
  readonly runTimeMs: number;
}

export interface CriterionTotals {
  readonly weighted_count: number;
  readonly sum: number;
  readonly sum_of_squares: number;
}

/** `AGG#ALL` (kind `all`) or `AGG#METHOD#<method>` (kind `method`) of one bean. */
export interface AggregateItem {
  readonly kind: 'all' | 'method';
  readonly bean_id: string;
  /** Present exactly when kind is `method`. */
  readonly method?: Method;
  readonly run_day: string;
  readonly weight_denominator: number;
  readonly raters: number;
  readonly criteria: Readonly<Record<Criterion, CriterionTotals>>;
  readonly intensities: Readonly<Partial<Record<IntensityDimension, Readonly<Partial<Record<IntensityLevel, number>>>>>>;
  readonly notes: Readonly<Partial<Record<FlavourNote, number>>>;
  readonly buy_again: { readonly yes: number; readonly no: number };
  readonly histograms: Readonly<Partial<Record<HistogramParameterId, Readonly<Record<string, number>>>>>;
  readonly raters_by_part: {
    readonly buy_again: number;
    readonly notes: number;
    readonly intensities: Readonly<Partial<Record<IntensityDimension, number>>>;
    readonly histograms: Readonly<Partial<Record<HistogramParameterId, number>>>;
  };
}

/** A ranking list: `RANK#ALL`, `RANK#METHOD#<method>`, process, roast level, price band, or origin (by country). */
export type RankFacet =
  | { readonly kind: 'all' }
  | { readonly kind: 'method'; readonly value: Method }
  | { readonly kind: 'process'; readonly value: Process }
  | { readonly kind: 'roast_level'; readonly value: RoastLevel }
  | { readonly kind: 'price_band'; readonly value: PriceBand }
  | { readonly kind: 'origin'; readonly value: Origin };

export interface RankingItem {
  readonly facet: RankFacet;
  readonly run_day: string;
  /** Best first: higher mean `overall`, ties by bean id. Every bean here has at least the minimum distinct raters in this facet. */
  readonly bean_ids: readonly string[];
}

export interface RebuildCounts {
  /** Distinct users with at least one scanned brew, rejected and orphan brews included. A count only. */
  readonly users_seen: number;
  readonly brews_seen: number;
  readonly brews_counted: number;
  /** Brews of consenting users whose shelf entry was missing. Not a reason id. */
  readonly brews_orphaned: number;
  /** Every reason id of the contract, zeros included. */
  readonly reasons: Readonly<Record<ReasonId, number>>;
  readonly beans_with_aggregates: number;
  readonly beans_ranked: number;
}

export interface RebuildResult {
  /** Sorted by bean id, then `all` before methods, then method id. */
  readonly aggregates: readonly AggregateItem[];
  /** Sorted by facet. Lists that would be empty are not here. */
  readonly rankings: readonly RankingItem[];
  readonly counts: RebuildCounts;
}

/** The input is not what a decoded scan gives (a repeated bean, an undecodable timestamp, a score off the half-point grid). The run must fail. */
export class RebuildInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebuildInputError';
  }
}

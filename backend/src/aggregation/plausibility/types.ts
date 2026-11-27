// Inputs and outputs of the plausibility judge (ADR 0035 point 4, M3-T4). Plain
// data, no I/O types: the rebuild core maps stored items to these.
import type { Scores } from '../../generated/contract.ts';
import type { ReasonId } from '../../generated/aggregation.ts';

/** One brew as the rules see it. */
export interface PlausibilityBrew {
  readonly userId: string;
  readonly brewId: string;
  readonly shelfEntryId: string;
  /** `brewed_at` as epoch milliseconds (an instant; its UTC day is what the rules use). */
  readonly brewedAtMs: number;
  /** `dose_dg`, decigrams, when the brew has one. */
  readonly doseDg?: number | undefined;
  /** The rating's eight scores in points (1 to 10 in half steps). Absent means the brew is unrated. */
  readonly scores?: Scores | undefined;
}

/** The shelf entry a brew belongs to (looked up by user and id). */
export interface PlausibilityShelfEntry {
  readonly userId: string;
  readonly shelfEntryId: string;
  readonly beanId: string;
  /** `YYYY-MM-DD`, when known. Without it rule 4 does not judge. */
  readonly roastDate?: string | undefined;
  /** The bag size in grams, when known. Without it rule 6 does not judge. */
  readonly bagGrams?: number | undefined;
}

export type Verdict = 'counted' | ReasonId;

export interface BrewVerdict {
  readonly userId: string;
  readonly brewId: string;
  readonly verdict: Verdict;
}

/** The input is not what a scan of a consistent table gives (a brew without its shelf entry, a duplicate). The run must fail. */
export class PlausibilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlausibilityInputError';
  }
}

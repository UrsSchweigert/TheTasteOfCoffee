// Every threshold of the nightly rebuild (ADR 0035, M3-T3), in one place. The
// owner tunes the starting values from the per-reason counts in the logs
// (M3-T15); changing one is a code change here and a deploy, not a new ADR.
// Nothing else under src/aggregation/ may write these numbers (a test greps for it).

/** `L = lcm(1..10)`. A cup in a group of n counted cups weighs `L / n`; a group weighs exactly L (one vote). */
export const WEIGHT_DENOMINATOR = 2520;

/** At most this many cups of one bean per user per UTC day count (owner decision, 2026-11-26). Also the largest group size n. */
export const DAILY_CAP = 10;

/** Distinct raters an aggregate needs before any endpoint returns it (CLAUDE.md invariant 4). */
export const MIN_RATERS = 5;

/** Rule 3: a brew more than this long after the run time is in the future (clock skew). */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Rule 5: more than `BURST_COUNT` brews of one user within any window of this length is a burst. */
export const BURST_WINDOW_MS = 60 * 1000;
/** Rule 5: the earliest this many brews of a window count. */
export const BURST_COUNT = 5;

/** Rule 6: the running dose of a shelf entry may not exceed bag size x this percentage / 100 (1.10, kept as an integer so no float is involved). */
export const BAG_DOSE_MARGIN_PERCENT = 110;

/** Rule 6 unit conversions: doses are decigrams, bag sizes grams (x this), and the margin is a percentage (/ this). */
export const DECIGRAMS_PER_GRAM = 10;
export const PERCENT_DENOMINATOR = 100;

/** Rule 7: a user needs at least this many rated brews to be judged for straight-lining. */
export const STRAIGHT_LINING_MIN_BREWS = 10;

/** Scores are integer half-points: 1 to 10 in half steps, so 2 to 20. */
export const MIN_HALF_POINTS = 2;
export const MAX_HALF_POINTS = 20;

/** Age limit of a stamped aggregate (ADR 0035 point 7a): older than this many days is "not available". */
export const MAX_AGE_DAYS = 3;

/** An unchanged aggregate item is rewritten to refresh its stamp once it is this many days behind the run day (ADR 0035 point 8). */
export const REFRESH_AFTER_DAYS = 2;

/** Largest weighted half-point sum one cup adds to a criterion: 20 x L = 50,400. */
export const MAX_SUM_PER_CUP = MAX_HALF_POINTS * WEIGHT_DENOMINATOR;

/** Largest weighted sum of squares one cup adds to a criterion: 400 x L = 1,008,000. */
export const MAX_SUM_OF_SQUARES_PER_CUP = MAX_HALF_POINTS * MAX_HALF_POINTS * WEIGHT_DENOMINATOR;

/**
 * Counted cups after which the sum of squares could pass 2^53 - 1: about 8.9e9
 * (ADR 0035 point 3). The assertion in arithmetic.ts is what actually guards
 * a run; this is the figure the tests and the logs compare against.
 */
export const MAX_EXACT_CUPS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_SUM_OF_SQUARES_PER_CUP);

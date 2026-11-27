// Helpers for the seeded campaigns of the rebuild property tests (M3-T6).
import type { RankFacet, RebuildResult } from '../../../src/aggregation/rebuild/types.ts';
import { Rng, seeds } from './rng.ts';

/** Histories per property. The task asks for at least 200; the seeds are 1..CAMPAIGN_SIZE, so a failure is reproduced by its seed. */
export const CAMPAIGN_SIZE = 300;

/** Runs `body` once per seed. A failure names the seed (the case is `new Rng(seed)` of the same generator). */
export function forEachSeed(body: (rng: Rng, seed: number) => void, count = CAMPAIGN_SIZE): void {
  for (const seed of seeds(count)) {
    try {
      body(new Rng(seed), seed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`seed ${String(seed)}: ${message}`, { cause: error });
    }
  }
}

export const facetKey = (facet: RankFacet): string => ('value' in facet ? `${facet.kind}/${facet.value}` : facet.kind);

/** The result with the ranking lists in a fixed order, so two results can be compared item by item without relying on the list order. */
export function normalised(result: RebuildResult): RebuildResult {
  return { ...result, rankings: [...result.rankings].sort((a, b) => (facetKey(a.facet) < facetKey(b.facet) ? -1 : 1)) };
}

/** Aggregates and rankings only (the counts of two histories differ when a brew is removed). */
export function numbersOf(result: RebuildResult): { aggregates: RebuildResult['aggregates']; rankings: RebuildResult['rankings'] } {
  const { aggregates, rankings } = normalised(result);
  return { aggregates, rankings };
}

/** Calls `visit` with every number in a JSON-like value. */
export function visitNumbers(value: unknown, visit: (n: number) => void): void {
  if (typeof value === 'number') visit(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) visitNumbers(item, visit);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) visitNumbers(item, visit);
}

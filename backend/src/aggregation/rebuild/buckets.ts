// Histogram bucket assignment (contracts/aggregation/v1/histogram_buckets.json,
// generated into src/generated/aggregation.ts). All edges are integers in the
// parameter's scaled unit, so a cup's bucket is found with integer comparisons
// only; the ratio is never divided (contracts/README.md, Histogram buckets).
import { HISTOGRAM_PARAMETERS, HISTOGRAM_PARAMETER_IDS, type HistogramBucket, type HistogramParameterId, type HistogramSet } from '../../generated/aggregation.ts';
import type { BrewParameters, Method } from '../../generated/contract.ts';
import { DECIGRAMS_PER_GRAM } from '../config.ts';

/** `parameter -> method -> set`: a method is in exactly one set per parameter, and in none where the parameter does not apply. */
const SET_OF: ReadonlyMap<HistogramParameterId, ReadonlyMap<Method, HistogramSet>> = new Map(
  HISTOGRAM_PARAMETER_IDS.map((id) => {
    const bySet = new Map<Method, HistogramSet>();
    for (const set of HISTOGRAM_PARAMETERS[id].sets) for (const method of set.methods) bySet.set(method, set);
    return [id, bySet];
  }),
);

/** Every bucket id of one parameter, in contract order (used to emit maps in a fixed order). */
export const BUCKET_IDS: Readonly<Record<HistogramParameterId, readonly string[]>> = {
  ratio: bucketIdsOf('ratio'),
  grind_normalised: bucketIdsOf('grind_normalised'),
  water_temp_c: bucketIdsOf('water_temp_c'),
  brew_time_s: bucketIdsOf('brew_time_s'),
};

function bucketIdsOf(id: HistogramParameterId): string[] {
  return HISTOGRAM_PARAMETERS[id].sets.flatMap((set) => set.buckets.map((bucket) => bucket.id));
}

function pick(buckets: readonly HistogramBucket[], inside: (bucket: HistogramBucket) => boolean): string | undefined {
  return buckets.find(inside)?.id;
}

/** The bucket id of one parameter for a cup, or undefined if the cup lacks the parameter or the method has no set for it. */
export function bucketOf(parameter: HistogramParameterId, parameters: BrewParameters): string | undefined {
  const set = SET_OF.get(parameter)?.get(parameters.method);
  if (!set) return undefined;
  const { scale } = HISTOGRAM_PARAMETERS[parameter];
  const scaled = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : pick(set.buckets, (bucket) => value * scale >= bucket.from && value * scale < bucket.to);
  switch (parameter) {
    case 'ratio': {
      const { water_g: water, dose_dg: dose } = parameters;
      if (water === undefined || dose === undefined) return undefined;
      // ratio (scaled) = scale x water_g / (dose_dg / 10): compare cross-multiplied, no division.
      const lhs = scale * DECIGRAMS_PER_GRAM * water;
      return pick(set.buckets, (bucket) => lhs >= bucket.from * dose && lhs < bucket.to * dose);
    }
    case 'grind_normalised':
      return scaled(parameters.grind_normalised);
    case 'water_temp_c':
      return scaled(parameters.water_temp_c);
    case 'brew_time_s':
      return scaled(parameters.brew_time_s);
  }
}

/** The (parameter, bucket id) pairs a cup adds to, in contract parameter order. */
export function bucketsOf(parameters: BrewParameters): readonly (readonly [HistogramParameterId, string])[] {
  const result: (readonly [HistogramParameterId, string])[] = [];
  for (const parameter of HISTOGRAM_PARAMETER_IDS) {
    const bucket = bucketOf(parameter, parameters);
    if (bucket !== undefined) result.push([parameter, bucket]);
  }
  return result;
}

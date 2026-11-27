// Loading and checking of the aggregation contract (ADR 0035, task M3-T2):
// the plausibility reason ids and the histogram buckets of the recipe
// parameters. Files live in aggregation/v<N>/, outside the vocabulary, so no
// vocabulary version changes. Every check returns a list of problem strings.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { CONTRACTS_DIR, ID_PATTERN } from './vocabulary.mjs';

export const AGGREGATION_DIR = join(CONTRACTS_DIR, 'aggregation');
export const AGGREGATION_VERSION = 1;

/** The ids the owner fixed in ADR 0035 point 4, in the order of the rules. */
export const REASON_IDS = [
  'no_consent',
  'unrated',
  'brewed_in_future',
  'brewed_before_roast',
  'burst',
  'bag_dose_exceeded',
  'straight_lining',
  'daily_cap_exceeded',
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function loadReasons(version = AGGREGATION_VERSION, dir = AGGREGATION_DIR) {
  return readJson(join(dir, `v${version}`, 'reasons.json'));
}
export function loadBuckets(version = AGGREGATION_VERSION, dir = AGGREGATION_DIR) {
  return readJson(join(dir, `v${version}`, 'histogram_buckets.json'));
}
export function loadAggregationSchemas(dir = AGGREGATION_DIR) {
  return {
    reasons: readJson(join(dir, 'schema', 'reasons.schema.json')),
    buckets: readJson(join(dir, 'schema', 'histogram_buckets.schema.json')),
  };
}

function validate(schema, content, name) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const check = ajv.compile(schema);
  if (check(content)) return [];
  return check.errors.map((error) => `${name}: ${error.instancePath || '/'} ${error.message}`);
}
export const validateReasons = (content, schema) => validate(schema, content, 'reasons.json');
export const validateBuckets = (content, schema) => validate(schema, content, 'histogram_buckets.json');

/** Ids are unique and equal the fixed list, in order. */
export function checkReasons(content, expected = REASON_IDS) {
  const ids = content.reasons.map((reason) => reason.id);
  const problems = [];
  const seen = new Set();
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) problems.push(`reason ${id}: not snake_case`);
    if (seen.has(id)) problems.push(`reason ${id}: duplicate`);
    seen.add(id);
  }
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    problems.push(`reasons are [${ids.join(', ')}], expected [${expected.join(', ')}]`);
  }
  return problems;
}

/**
 * The integer range (in the parameter's scaled units, `to` exclusive) that
 * a parameter's buckets must cover, from the vocabulary ranges.
 *   ratio: 100 x water_g / dose_dg in tenths of water per dose (the ratio of
 *     the smallest water over the largest dose up to the largest water over
 *     the smallest dose); the first bucket starts at 0.
 *   others: the range of the field, scaled; the last `to` is one step above.
 */
export function requiredCover(parameter, ranges) {
  if (parameter === 'ratio') {
    const dose = ranges.dose_g;
    const water = ranges.water_g;
    // dose_dg = dose_g x 10 (ADR 0004); ratio tenths = 100 x water_g / dose_dg.
    const highest = Math.floor((100 * water.maximum) / (dose.minimum * 10));
    // Exact: a bucket from starts at or below the lowest ratio when from x dose_max_dg <= 100 x water_min.
    return { lowest: 0, highest, startsAtOrBelowLowest: (from) => from * dose.maximum * 10 <= 100 * water.minimum };
  }
  const range = ranges[parameter === 'grind_normalised' ? 'grind_normalised' : parameter];
  const scale = parameter === 'grind_normalised' ? 2 : 1;
  const step = range.multipleOf * scale;
  return { lowest: range.minimum * scale, highest: range.maximum * scale, startsAtOrBelowLowest: (from) => from <= range.minimum * scale, step };
}

/**
 * Checks bucket definitions against the vocabulary of `buckets.vocabulary_version`:
 * - every set names methods of that version, each method at most once per parameter;
 * - the sets of a parameter cover exactly the methods that may carry the field
 *   (all methods, or the `field_rules` methods; ratio needs dose and water,
 *   which every method allows);
 * - buckets are ordered, contiguous (each `from` is the previous `to`), not
 *   overlapping, non-empty (`from` < `to`), and cover the range of the field;
 * - every edge is an integer in the scaled unit, so it is exact in binary;
 * - every bucket id is unique across the whole file and starts with
 *   `<parameter>_<set>_from_` and ends with its own `from`.
 */
export function checkBuckets(content, vocabulary) {
  const problems = [];
  const methods = vocabulary.brew.methods.map((method) => method.id);
  const ranges = vocabulary.brew.ranges;
  const rules = vocabulary.brew.field_rules ?? {};
  const scales = { ratio: 10, grind_normalised: 2, water_temp_c: 1, brew_time_s: 1 };
  const allIds = new Set();

  for (const [name, parameter] of Object.entries(content.parameters)) {
    if (parameter.scale !== scales[name]) problems.push(`${name}: scale ${parameter.scale}, expected ${scales[name]}`);
    const expectedMethods = rules[name] ? methods.filter((m) => rules[name].allowed_methods[m]) : methods;
    const covered = new Map();
    const setIds = new Set();
    for (const set of parameter.sets) {
      if (setIds.has(set.id)) problems.push(`${name}.${set.id}: duplicate set id`);
      setIds.add(set.id);
      for (const method of set.methods) {
        if (!methods.includes(method)) problems.push(`${name}.${set.id}: unknown method ${method}`);
        if (covered.has(method)) problems.push(`${name}: method ${method} is in sets ${covered.get(method)} and ${set.id}`);
        covered.set(method, set.id);
      }
    }
    for (const method of expectedMethods) {
      if (!covered.has(method)) problems.push(`${name}: method ${method} has no bucket set`);
    }
    for (const method of covered.keys()) {
      if (!expectedMethods.includes(method)) problems.push(`${name}: method ${method} may not carry this field`);
    }

    const cover = requiredCover(name, ranges);
    for (const set of parameter.sets) {
      const where = `${name}.${set.id}`;
      let previousTo;
      set.buckets.forEach((bucket, index) => {
        if (!Number.isInteger(bucket.from) || !Number.isInteger(bucket.to)) problems.push(`${where}.${bucket.id}: edges must be integers`);
        if (bucket.from >= bucket.to) problems.push(`${where}.${bucket.id}: empty or reversed (from ${bucket.from}, to ${bucket.to})`);
        if (index === 0) {
          if (!cover.startsAtOrBelowLowest(bucket.from)) problems.push(`${where}: first bucket starts at ${bucket.from}, above the lowest value`);
          if (name !== 'ratio' && bucket.from !== cover.lowest) problems.push(`${where}: first bucket starts at ${bucket.from}, expected ${cover.lowest}`);
        } else if (bucket.from !== previousTo) {
          problems.push(`${where}.${bucket.id}: from ${bucket.from} is not the previous to ${previousTo} (gap or overlap)`);
        }
        previousTo = bucket.to;
        if (!bucket.id.startsWith(`${name}_${set.id}_from_`) || !bucket.id.endsWith(`_from_${bucket.from}`)) {
          problems.push(`${where}.${bucket.id}: id must be ${name}_${set.id}_from_${bucket.from}`);
        }
        if (allIds.has(bucket.id)) problems.push(`${where}.${bucket.id}: duplicate bucket id`);
        allIds.add(bucket.id);
      });
      const last = set.buckets.at(-1);
      if (last && last.to <= cover.highest) problems.push(`${where}: last bucket ends at ${last.to}, must be above ${cover.highest}`);
      if (last && name !== 'ratio' && last.to !== cover.highest + (cover.step ?? 1)) {
        problems.push(`${where}: last bucket ends at ${last.to}, expected ${cover.highest + (cover.step ?? 1)}`);
      }
    }
  }
  return problems;
}

/**
 * The bucket id of a value, for tests and as the reference for the backend.
 * ratio takes water_g and dose_dg; the others take the raw field value.
 * Exact: only integer arithmetic (the grind is doubled, ADR 0004).
 */
export function bucketOf(content, parameter, method, values) {
  const definition = content.parameters[parameter];
  const set = definition.sets.find((candidate) => candidate.methods.includes(method));
  if (!set) return undefined;
  const test = (bucket) => {
    if (parameter === 'ratio') {
      const scaled = 100 * values.water_g;
      return scaled >= bucket.from * values.dose_dg && scaled < bucket.to * values.dose_dg;
    }
    const value = parameter === 'grind_normalised' ? values.grind_normalised * 2 : values[parameter];
    return value >= bucket.from && value < bucket.to;
  };
  return set.buckets.find(test)?.id;
}

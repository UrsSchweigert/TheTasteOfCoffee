import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASON_IDS,
  bucketOf,
  checkBuckets,
  checkReasons,
  loadAggregationSchemas,
  loadBuckets,
  loadReasons,
  validateBuckets,
  validateReasons,
} from '../lib/aggregation.mjs';
import { listVersions, loadVocabulary } from '../lib/vocabulary.mjs';

const clone = (value) => structuredClone(value);
const schemas = loadAggregationSchemas();
const reasons = loadReasons();
const buckets = loadBuckets();
const vocabulary = loadVocabulary(buckets.vocabulary_version);

// ---- The real files. ----

test('reasons.json validates against its schema and holds exactly the eight ids of ADR 0035', () => {
  assert.deepEqual(validateReasons(reasons, schemas.reasons), []);
  assert.deepEqual(checkReasons(reasons), []);
  assert.deepEqual(
    reasons.reasons.map((reason) => reason.id),
    ['no_consent', 'unrated', 'brewed_in_future', 'brewed_before_roast', 'burst', 'bag_dose_exceeded', 'straight_lining', 'daily_cap_exceeded'],
  );
});

test('histogram_buckets.json validates against its schema', () => {
  assert.deepEqual(validateBuckets(buckets, schemas.buckets), []);
});

test('the buckets follow a published vocabulary version', () => {
  assert.ok(listVersions().includes(buckets.vocabulary_version));
  assert.equal(vocabulary.brew.status, 'published');
});

test('buckets are contiguous, non-overlapping, cover the field range, and ids are unique', () => {
  assert.deepEqual(checkBuckets(buckets, vocabulary), []);
});

test('the parameter set is the one docs/04 F4 names: ratio, temperature, grind, time', () => {
  assert.deepEqual(Object.keys(buckets.parameters).sort(), ['brew_time_s', 'grind_normalised', 'ratio', 'water_temp_c']);
});

test('temperature buckets exist exactly for the methods that allow water_temp_c (v3 field rules)', () => {
  const allowed = Object.keys(vocabulary.brew.field_rules.water_temp_c.allowed_methods).sort();
  const covered = buckets.parameters.water_temp_c.sets.flatMap((set) => set.methods).sort();
  assert.deepEqual(covered, allowed);
  assert.ok(!covered.includes('cold_brew'));
});

test('bucketOf puts every edge value, and the extremes of the vocabulary ranges, in exactly one bucket', () => {
  // Ratio edges are tenths of water per coffee: 15 is 1:1.5, 150 is 1:15.
  assert.equal(bucketOf(buckets, 'ratio', 'espresso', { water_g: 30, dose_dg: 200 }), 'ratio_espresso_from_15'); // 1:1.5 exactly
  assert.equal(bucketOf(buckets, 'ratio', 'espresso', { water_g: 29, dose_dg: 200 }), 'ratio_espresso_from_10'); // just below
  assert.equal(bucketOf(buckets, 'ratio', 'v60', { water_g: 300, dose_dg: 200 }), 'ratio_filter_from_150'); // 1:15 exactly
  assert.equal(bucketOf(buckets, 'ratio', 'v60', { water_g: 10, dose_dg: 1000 }), 'ratio_filter_from_0'); // lowest possible ratio
  assert.equal(bucketOf(buckets, 'ratio', 'v60', { water_g: 1500, dose_dg: 50 }), 'ratio_filter_from_250'); // highest possible ratio
  assert.equal(bucketOf(buckets, 'water_temp_c', 'v60', { water_temp_c: 80 }), 'water_temp_c_hot_from_80');
  assert.equal(bucketOf(buckets, 'water_temp_c', 'v60', { water_temp_c: 100 }), 'water_temp_c_hot_from_100');
  assert.equal(bucketOf(buckets, 'water_temp_c', 'v60', { water_temp_c: 91 }), 'water_temp_c_hot_from_90');
  assert.equal(bucketOf(buckets, 'water_temp_c', 'cold_brew', { water_temp_c: 20 }), undefined);
  assert.equal(bucketOf(buckets, 'grind_normalised', 'v60', { grind_normalised: 1 }), 'grind_normalised_all_from_2');
  assert.equal(bucketOf(buckets, 'grind_normalised', 'v60', { grind_normalised: 1.5 }), 'grind_normalised_all_from_2');
  assert.equal(bucketOf(buckets, 'grind_normalised', 'v60', { grind_normalised: 2 }), 'grind_normalised_all_from_4');
  assert.equal(bucketOf(buckets, 'grind_normalised', 'v60', { grind_normalised: 10 }), 'grind_normalised_all_from_18');
  assert.equal(bucketOf(buckets, 'brew_time_s', 'espresso', { brew_time_s: 1 }), 'brew_time_s_espresso_from_1');
  assert.equal(bucketOf(buckets, 'brew_time_s', 'espresso', { brew_time_s: 24 }), 'brew_time_s_espresso_from_20');
  assert.equal(bucketOf(buckets, 'brew_time_s', 'espresso', { brew_time_s: 25 }), 'brew_time_s_espresso_from_25');
  assert.equal(bucketOf(buckets, 'brew_time_s', 'cold_brew', { brew_time_s: 172800 }), 'brew_time_s_cold_brew_from_86400');
});

test('every value of every parameter range lands in exactly one bucket per method', () => {
  const ranges = vocabulary.brew.ranges;
  const methods = vocabulary.brew.methods.map((method) => method.id);
  const count = (parameter, method, values) => {
    const set = buckets.parameters[parameter].sets.find((candidate) => candidate.methods.includes(method));
    if (!set) return 0;
    return set.buckets.filter((bucket) => bucketOf({ parameters: { [parameter]: { sets: [{ methods: [method], buckets: [bucket] }] } } }, parameter, method, values)).length;
  };
  for (const method of methods) {
    for (let g = ranges.grind_normalised.minimum * 2; g <= ranges.grind_normalised.maximum * 2; g += 1) {
      assert.equal(count('grind_normalised', method, { grind_normalised: g / 2 }), 1, `grind ${g / 2} ${method}`);
    }
    for (const time of [1, 2, 14, 15, 59, 60, 61, 600, 21599, 21600, 86399, 86400, 172799, 172800]) {
      assert.equal(count('brew_time_s', method, { brew_time_s: time }), 1, `time ${time} ${method}`);
    }
    for (const water of [10, 11, 250, 1499, 1500]) {
      for (const dose of [50, 51, 180, 999, 1000]) {
        assert.equal(count('ratio', method, { water_g: water, dose_dg: dose }), 1, `ratio ${water}/${dose} ${method}`);
      }
    }
  }
  const hot = Object.keys(vocabulary.brew.field_rules.water_temp_c.allowed_methods);
  for (const method of hot) {
    for (let t = ranges.water_temp_c.minimum; t <= ranges.water_temp_c.maximum; t += 1) {
      assert.equal(count('water_temp_c', method, { water_temp_c: t }), 1, `temp ${t} ${method}`);
    }
  }
});

test('bucket edges and ids are plain integers and snake_case, so counts need no float arithmetic', () => {
  for (const parameter of Object.values(buckets.parameters)) {
    for (const set of parameter.sets) {
      for (const bucket of set.buckets) {
        assert.ok(Number.isSafeInteger(bucket.from) && Number.isSafeInteger(bucket.to));
        assert.match(bucket.id, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      }
    }
  }
});

// ---- The checks themselves must be able to fail. ----

test('reasons check fails: missing, extra, duplicate, reordered and malformed ids', () => {
  const missing = clone(reasons);
  missing.reasons.pop();
  assert.ok(checkReasons(missing).length > 0);
  const extra = clone(reasons);
  extra.reasons.push({ id: 'new_reason' });
  assert.ok(checkReasons(extra).length > 0);
  const duplicate = clone(reasons);
  duplicate.reasons[1].id = 'no_consent';
  assert.ok(checkReasons(duplicate).some((p) => p.includes('duplicate')));
  const reordered = clone(reasons);
  reordered.reasons.reverse();
  assert.ok(checkReasons(reordered).length > 0);
  const upper = clone(reasons);
  upper.reasons[0].id = 'NoConsent';
  assert.ok(validateReasons(upper, schemas.reasons).length > 0);
  assert.ok(checkReasons(upper).some((p) => p.includes('snake_case')));
  assert.equal(REASON_IDS.length, 8);
});

test('reasons schema fails: label text, extra keys, an id with spaces', () => {
  const withText = clone(reasons);
  withText.reasons[0].label = 'No consent';
  assert.ok(validateReasons(withText, schemas.reasons).length > 0);
  const spaced = clone(reasons);
  spaced.reasons[0].id = 'no consent';
  assert.ok(validateReasons(spaced, schemas.reasons).length > 0);
});

function mutate(change) {
  const copy = clone(buckets);
  change(copy);
  return checkBuckets(copy, vocabulary);
}

test('bucket check fails: a gap, an overlap, a short cover, a duplicate id, a reversed bucket', () => {
  const ratio = (c) => c.parameters.ratio.sets[0].buckets;
  assert.ok(mutate((c) => { ratio(c)[2].from += 1; }).some((p) => p.includes('gap or overlap')));
  assert.ok(mutate((c) => { ratio(c)[2].from -= 1; }).some((p) => p.includes('gap or overlap')));
  assert.ok(mutate((c) => { ratio(c).at(-1).to = 3000; }).some((p) => p.includes('last bucket')));
  assert.ok(mutate((c) => { c.parameters.water_temp_c.sets[0].buckets[0].from = 81; }).length > 0);
  assert.ok(mutate((c) => { c.parameters.water_temp_c.sets[0].buckets.at(-1).to = 100; }).length > 0);
  assert.ok(mutate((c) => { c.parameters.brew_time_s.sets[0].buckets[1].id = c.parameters.brew_time_s.sets[0].buckets[0].id; }).some((p) => p.includes('duplicate bucket id')));
  assert.ok(mutate((c) => { c.parameters.grind_normalised.sets[0].buckets[0].to = 2; }).some((p) => p.includes('empty or reversed')));
  assert.ok(mutate((c) => { c.parameters.grind_normalised.sets[0].buckets[0].from = 2.5; }).some((p) => p.includes('integers')));
});

test('bucket check fails: a method without a set, in two sets, unknown, or not allowed by a field rule', () => {
  assert.ok(mutate((c) => { c.parameters.brew_time_s.sets[0].methods.pop(); }).some((p) => p.includes('has no bucket set')));
  assert.ok(mutate((c) => { c.parameters.ratio.sets[2].methods.push('espresso'); }).some((p) => p.includes('is in sets')));
  assert.ok(mutate((c) => { c.parameters.ratio.sets[2].methods.push('tea'); }).some((p) => p.includes('unknown method')));
  assert.ok(mutate((c) => { c.parameters.water_temp_c.sets[0].methods.push('cold_brew'); }).some((p) => p.includes('may not carry')));
  assert.ok(mutate((c) => { c.parameters.water_temp_c.sets[0].methods.pop(); }).some((p) => p.includes('has no bucket set')));
});

test('bucket check fails: a wrong scale and a wrongly named id', () => {
  assert.ok(mutate((c) => { c.parameters.grind_normalised.scale = 1; }).some((p) => p.includes('scale')));
  assert.ok(mutate((c) => { c.parameters.ratio.sets[0].buckets[1].id = 'ratio_espresso_from_11'; }).some((p) => p.includes('id must be')));
});

test('bucket schema fails: free text and a missing parameter', () => {
  const withText = clone(buckets);
  withText.parameters.ratio.sets[0].buckets[0].label = 'low';
  assert.ok(validateBuckets(withText, schemas.buckets).length > 0);
  const missing = clone(buckets);
  delete missing.parameters.brew_time_s;
  assert.ok(validateBuckets(missing, schemas.buckets).length > 0);
  const fractional = clone(buckets);
  fractional.parameters.ratio.sets[0].buckets[0].to = 10.5;
  assert.ok(validateBuckets(fractional, schemas.buckets).length > 0);
});

test('README documents every reason id, every parameter and the item attributes ADR 0035 requires', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const { id } of reasons.reasons) assert.ok(readme.includes(`\`${id}\``), id);
  for (const parameter of Object.keys(buckets.parameters)) assert.ok(readme.includes(`\`${parameter}\``), parameter);
  for (const attribute of ['run_day', 'raters', 'raters_by_part', 'sum_of_squares', 'weighted_count', 'intensities', 'notes', 'buy_again', 'histograms']) {
    assert.ok(readme.includes(`\`${attribute}\``), attribute);
  }
});

test('a first ratio bucket above the lowest possible ratio is rejected (exact comparison)', () => {
  const copy = clone(buckets);
  copy.parameters.ratio.sets[0].buckets[0].from = 2; // the lowest ratio is 1 tenth
  assert.ok(checkBuckets(copy, vocabulary).some((p) => p.includes('above the lowest value')));
});

test('every vocabulary version from the bucket version up to the latest still fits the buckets', () => {
  const later = listVersions().filter((version) => version >= buckets.vocabulary_version);
  for (const version of later) {
    assert.deepEqual(checkBuckets(buckets, loadVocabulary(version)), [], `vocabulary v${version}: add aggregation/v2/ for the change`);
  }
});

test('drift check fails: a later vocabulary version with a new method, or a widened range', () => {
  const withMethod = clone(vocabulary);
  withMethod.brew.methods.push({ id: 'turkish_sand' });
  assert.ok(checkBuckets(buckets, withMethod).some((p) => p.includes('turkish_sand') && p.includes('no bucket set')));
  const wider = clone(vocabulary);
  wider.brew.ranges.water_temp_c.maximum = 105;
  assert.ok(checkBuckets(buckets, wider).length > 0);
});

// Tests for scripts/reference-recipes/convert.mjs and the committed reference recipe set (M2-T46, ADR 0034).
// Run: node --test scripts/reference-recipes.test.mjs (no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRIND_WORDS, buildDataset, convert, methodOf, parseCsv } from './reference-recipes/convert.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brew = JSON.parse(readFileSync(join(root, 'contracts', 'vocabulary', 'v3', 'brew.json'), 'utf8'));
const methodIds = brew.methods.map((m) => m.id);

const HEADER = ['recipe_id', 'recipe_name', 'method', 'brewer', 'author', 'coffee_g_source', 'water_g_source', 'grind', 'total_recipe_time_s', 'water_temperature_start_c', 'quality_flags', 'source_url'];
const row = (o) => Object.fromEntries(HEADER.map((k) => [k, o[k] ?? '']));
const base = { recipe_id: 'x-1', recipe_name: 'Somebody Wins 2019', author: 'Some Person', source_url: 'https://example.test/r', method: 'AeroPress', brewer: 'AeroPress', coffee_g_source: '17', water_g_source: '250', grind: 'Medium', total_recipe_time_s: '120', water_temperature_start_c: '88' };

test('parseCsv reads quoted fields, doubled quotes, line breaks and a byte order mark', () => {
  const text = '﻿a,b,c\r\n1,"two, with comma","three ""quoted""\nand a break"\r\n4,5,6\r\n';
  assert.deepEqual(parseCsv(text), [
    { a: '1', b: 'two, with comma', c: 'three "quoted"\nand a break' },
    { a: '4', b: '5', c: '6' },
  ]);
});

test('methodOf maps what the vocabulary has and drops the rest instead of forcing it', () => {
  assert.equal(methodOf('Pour-over', 'Hario V60 NEO 02'), 'v60');
  assert.equal(methodOf('Pour-over', 'V60 01'), 'v60');
  assert.equal(methodOf('Pour-over', 'Chemex lookalike'), 'chemex');
  assert.equal(methodOf('AeroPress', 'Chemex Cup'), 'aeropress');
  assert.equal(methodOf('Pour-over', 'Kalita Wave 185'), 'kalita');
  assert.equal(methodOf('Chemex pour-over', 'Chemex 6 Cup'), 'chemex');
  assert.equal(methodOf('AeroPress', 'AeroPress Go'), 'aeropress');
  assert.equal(methodOf('Ibrik / Turkish', 'Ibrik / Cezve'), 'cezve');
  assert.equal(methodOf('Moka pot', 'Moka Pot'), 'moka_pot');
  assert.equal(methodOf('Pour-over', 'Orea Z1'), null);
  assert.equal(methodOf('Pour-over', 'Cafec Deep 27'), null);
  assert.equal(methodOf('Immersion / release', 'Clever Dripper L'), null);
  assert.equal(methodOf('Hybrid immersion / percolation', 'Hario Switch 02'), null);
  for (const id of ['v60', 'kalita', 'chemex', 'aeropress', 'cezve', 'moka_pot', 'siphon', 'french_press', 'cold_brew']) {
    assert.ok(methodIds.includes(id), `${id} is a vocabulary method`);
  }
});

test('a row becomes numbers only: no name, author, link or any text survives', () => {
  const { recipes } = convert([row(base)], brew);
  assert.equal(recipes.length, 1);
  assert.deepEqual(recipes[0], {
    id: 'ref0001',
    parameters: { method: 'aeropress', dose_dg: 170, water_g: 250, water_temp_c: 88, brew_time_s: 120, grind_normalised: 5.5 },
    inferred: [],
  });
  const text = JSON.stringify(recipes);
  for (const leak of ['Somebody', 'Some Person', 'example.test', 'x-1']) assert.ok(!text.includes(leak), leak);
});

test('rows that cannot be trusted are dropped with a reason', () => {
  const rows = [
    row({ ...base, brewer: 'Orea Z1', method: 'Pour-over' }),
    row({ ...base, quality_flags: 'bypass_or_dilution_check_water_basis' }),
    row({ ...base, quality_flags: 'ice_or_iced_service_check_water_basis' }),
    row({ ...base, coffee_g_source: '' }),
    row({ ...base, method: 'Cold brew', brewer: 'Cold Brew', coffee_g_source: '340', water_g_source: '1600' }),
  ];
  const { recipes, report } = convert(rows, brew);
  assert.equal(recipes.length, 0);
  assert.deepEqual(report.dropped, { no_matching_method: 1, water_basis_unclear: 2, dose_or_water_missing: 1, outside_vocabulary_range: 1 });
});

test('a published number outside the vocabulary range drops the row: it is not a missing number', () => {
  const rows = [
    // a cold steep of 4 degrees is not a hot French press brew
    row({ ...base, method: 'French press', brewer: 'French Press 3 Cup', water_temperature_start_c: '4', total_recipe_time_s: '54000', coffee_g_source: '60', water_g_source: '400' }),
    row({ ...base, water_temperature_start_c: '75', coffee_g_source: '15' }),
    row({ ...base, total_recipe_time_s: '999999', coffee_g_source: '16' }),
    row({ ...base, water_temperature_start_c: '', coffee_g_source: '17' }),
    row({ ...base, water_temperature_start_c: '90', coffee_g_source: '18' }),
  ];
  const { recipes, report } = convert(rows, brew);
  assert.equal(report.dropped.temperature_outside_range, 2);
  assert.equal(report.dropped.time_outside_range, 1);
  assert.equal(recipes.length, 2);
  const filled = recipes.find((r) => r.inferred.length > 0);
  assert.deepEqual(filled.inferred, ['water_temp_c']);
  assert.equal(filled.parameters.water_temp_c, 90, 'the median of what was published, not of what was dropped');
});

test('the medians for missing numbers come from published values only, whatever the order', () => {
  const rows = [
    row({ ...base, total_recipe_time_s: '100', coffee_g_source: '15' }),
    row({ ...base, total_recipe_time_s: '', coffee_g_source: '16' }),
    row({ ...base, total_recipe_time_s: '300', coffee_g_source: '17' }),
    row({ ...base, total_recipe_time_s: '', coffee_g_source: '18' }),
  ];
  const forward = convert(rows, brew).recipes;
  const backward = convert([...rows].reverse(), brew).recipes;
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.filter((r) => r.inferred.length).map((r) => r.parameters.brew_time_s), [200, 200]);
});

test('typical ranges leave out inferred values and groups that are too small', () => {
  const rows = [
    ...[10, 11, 12, 13, 14].map((g) => row({ ...base, coffee_g_source: String(g), water_g_source: String(g * 15), water_temperature_start_c: String(90 + g - 10) })),
    row({ ...base, coffee_g_source: '15', water_g_source: '225', water_temperature_start_c: '' }),
    row({ ...base, method: 'Moka pot', brewer: 'Moka Pot', coffee_g_source: '15', water_g_source: '150' }),
  ];
  const { ranges } = convert(rows, brew);
  assert.ok(ranges.aeropress);
  assert.equal(ranges.aeropress.recipes, 6);
  assert.deepEqual(ranges.aeropress.water_temp_c, { p10: 90.4, median: 92, p90: 93.6 });
  assert.equal(ranges.moka_pot, undefined, 'one recipe is too few for ranges');
});

test('a missing number takes the median of the same method and is marked inferred; nothing else is invented', () => {
  const rows = [
    row({ ...base, total_recipe_time_s: '100', coffee_g_source: '15' }),
    row({ ...base, total_recipe_time_s: '140', coffee_g_source: '16' }),
    row({ ...base, total_recipe_time_s: '', coffee_g_source: '17' }),
    row({ ...base, grind: 'unknown word', coffee_g_source: '18', total_recipe_time_s: '120' }),
  ];
  const { recipes } = convert(rows, brew);
  assert.equal(recipes.length, 4);
  const time = recipes.find((r) => r.inferred.includes('brew_time_s'));
  assert.equal(time.parameters.brew_time_s, 120);
  const grind = recipes.find((r) => r.inferred.includes('grind_normalised'));
  assert.equal(grind.parameters.grind_normalised, 5.5);
  assert.equal(recipes.filter((r) => r.inferred.length > 0).length, 2);
});

test('field rules: no temperature for moka pot or cezve, "cold" for cold brew, ratings never appear', () => {
  const rows = [
    row({ ...base, method: 'Moka pot', brewer: 'Moka Pot', coffee_g_source: '15', water_g_source: '150' }),
    row({ ...base, method: 'Ibrik / Turkish', brewer: 'Ibrik / Cezve', coffee_g_source: '10', water_g_source: '100' }),
    row({ ...base, method: 'Cold brew', brewer: 'Cold Brew', coffee_g_source: '100', water_g_source: '1000', total_recipe_time_s: '43200' }),
  ];
  const { recipes } = convert(rows, brew);
  const by = Object.fromEntries(recipes.map((r) => [r.parameters.method, r.parameters]));
  assert.equal(by.moka_pot.water_temp_c, undefined);
  assert.equal(by.cezve.water_temp_c, undefined);
  assert.equal(by.cold_brew.water_temp_c, undefined);
  assert.equal(by.cold_brew.water_temp_special, 'cold');
  assert.ok(!JSON.stringify(recipes).match(/score|rating|rater/i));
});

test('duplicates collapse to one recipe, and the order and ids do not follow the input', () => {
  const a = row({ ...base, coffee_g_source: '20', water_g_source: '300' });
  const b = row({ ...base, coffee_g_source: '15', water_g_source: '225' });
  const one = convert([a, { ...a, recipe_id: 'x-2' }, b], brew);
  assert.equal(one.recipes.length, 2);
  assert.equal(one.report.duplicates, 1);
  const two = convert([b, a], brew);
  assert.deepEqual(one.recipes, two.recipes);
});

test('typical ranges describe the published recipes and are not ratings', () => {
  const rows = [10, 15, 20, 25, 30].map((g) => row({ ...base, coffee_g_source: String(g), water_g_source: String(g * 15) }));
  const { dataset } = buildDataset(`${HEADER.join(',')}\n${rows.map((r) => HEADER.map((k) => r[k]).join(',')).join('\n')}\n`, brew);
  const range = dataset.typical_ranges.aeropress;
  assert.equal(range.recipes, 5);
  assert.equal(range.dose_g.median, 20);
  assert.equal(range.ratio_water_per_dose.median, 15);
  assert.equal(dataset.kind, 'reference_recipes');
});

// ---- the committed set ----

const committed = JSON.parse(readFileSync(join(root, 'contracts', 'reference', 'recipes.v1.json'), 'utf8'));

test('the committed set is on vocabulary v3 and inside its ranges and field rules', () => {
  assert.equal(committed.kind, 'reference_recipes');
  assert.equal(committed.vocabulary_version, 3);
  assert.ok(committed.recipes.length >= 100);
  const ids = new Set();
  for (const { id, parameters: p, inferred } of committed.recipes) {
    assert.match(id, /^ref\d{4}$/);
    assert.ok(!ids.has(id), `duplicate id ${id}`);
    ids.add(id);
    assert.ok(methodIds.includes(p.method), `${id}: method`);
    // Cold brew carries the special temperature, and a temperature the source gave is never replaced.
    if (p.method === 'cold_brew') assert.equal(p.water_temp_special, 'cold', `${id}: cold brew`);
    const { ranges: r } = brew;
    assert.ok(Number.isInteger(p.dose_dg) && p.dose_dg >= r.dose_g.minimum * 10 && p.dose_dg <= r.dose_g.maximum * 10, `${id}: dose`);
    assert.ok(Number.isInteger(p.water_g) && p.water_g >= r.water_g.minimum && p.water_g <= r.water_g.maximum, `${id}: water`);
    if (p.water_temp_c !== undefined) {
      assert.ok(Number.isInteger(p.water_temp_c) && p.water_temp_c >= r.water_temp_c.minimum && p.water_temp_c <= r.water_temp_c.maximum, `${id}: temp`);
      assert.ok(brew.field_rules.water_temp_c.allowed_methods[p.method], `${id}: temperature not allowed for ${p.method}`);
      assert.equal(p.water_temp_special, undefined, `${id}: temperature and special exclude each other`);
    }
    if (p.water_temp_special !== undefined) {
      assert.equal(p.method, 'cold_brew');
      assert.ok(brew.water_temp_special.some((s) => s.id === p.water_temp_special));
    }
    if (p.brew_time_s !== undefined) assert.ok(Number.isInteger(p.brew_time_s) && p.brew_time_s >= r.brew_time_s.minimum && p.brew_time_s <= r.brew_time_s.maximum, `${id}: time`);
    if (p.grind_normalised !== undefined) {
      assert.ok(p.grind_normalised >= r.grind_normalised.minimum && p.grind_normalised <= r.grind_normalised.maximum && (p.grind_normalised * 2) % 1 === 0, `${id}: grind`);
      assert.ok(Object.values(GRIND_WORDS).includes(p.grind_normalised) || inferred.includes('grind_normalised'));
    }
    assert.deepEqual(Object.keys(p).filter((k) => !['method', 'dose_dg', 'water_g', 'water_temp_c', 'water_temp_special', 'brew_time_s', 'grind_normalised'].includes(k)), [], `${id}: unknown field`);
  }
});

test('the committed set holds numbers and vocabulary ids only: no name, link, text or rating', () => {
  const allowed = new Set([...methodIds, 'cold', 'water_temp_c', 'brew_time_s', 'grind_normalised']);
  for (const { id, parameters, inferred } of committed.recipes) {
    for (const [key, value] of Object.entries(parameters)) {
      if (typeof value === 'string') assert.ok(allowed.has(value), `${id}.${key}: ${value}`);
    }
    for (const f of inferred) assert.ok(allowed.has(f), `${id}: inferred ${f}`);
    assert.deepEqual(Object.keys({ id, parameters, inferred }).sort(), ['id', 'inferred', 'parameters']);
  }
  const text = JSON.stringify(committed);
  assert.doesNotMatch(text, /https?:|www\.|@|\b[a-z0-9-]+\.(com|cafe|uk|org|net|jp|co|io)\b/i);
  assert.doesNotMatch(text, /"(score|scores|rating|rater|raters|aggregate)"/i);
});

test('every typical range is computed from recipes in the set', () => {
  for (const [method, range] of Object.entries(committed.typical_ranges)) {
    assert.ok(methodIds.includes(method));
    const group = committed.recipes.filter((r) => r.parameters.method === method);
    assert.equal(range.recipes, group.length, method);
    assert.ok(range.dose_g.p10 <= range.dose_g.median && range.dose_g.median <= range.dose_g.p90);
  }
});

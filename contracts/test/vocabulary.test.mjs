import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES,
  checkI18n,
  checkSemantics,
  checkVersionEntries,
  collectIds,
  listVersions,
  loadI18n,
  loadSchemas,
  loadVocabulary,
  mergeIdLists,
  validateVocabulary,
} from '../lib/vocabulary.mjs';

const schemas = loadSchemas();
const versions = listVersions();
const clone = (value) => structuredClone(value);

test('at least version 1 exists', () => {
  assert.ok(versions.includes(1));
});

for (const version of versions) {
  test(`v${version}: the directory holds only <name>.json files`, () => {
    assert.deepEqual(checkVersionEntries(version), []);
  });

  test(`v${version}: every file validates against its JSON Schema`, () => {
    const files = loadVocabulary(version);
    assert.ok(Object.keys(files).length > 0);
    assert.deepEqual(validateVocabulary(files, schemas, version), []);
  });

  test(`v${version}: every array is an id list, ids are snake_case and unique per list`, () => {
    assert.deepEqual(collectIds(loadVocabulary(version)).problems, []);
  });

  test(`v${version}: ranges, bag sizes and price bands are consistent`, () => {
    assert.deepEqual(checkSemantics(loadVocabulary(version)), []);
  });
}

test('v1 holds the lists and values the specification names', () => {
  const files = loadVocabulary(1);
  const { lists } = collectIds(files);
  // docs/04-specification.md, F2
  assert.deepEqual(lists.methods, [
    'espresso', 'moka_pot', 'v60', 'chemex', 'kalita', 'batch_filter',
    'aeropress', 'french_press', 'cold_brew', 'cezve', 'siphon', 'fully_automatic',
  ]);
  assert.deepEqual(lists.water_types, ['tap', 'filtered', 'bottled', 'remineralised']);
  assert.deepEqual(lists.milk_types, ['none', 'dairy', 'oat', 'soy', 'almond', 'cashew', 'hazelnut', 'macadamia', 'coconut', 'rice', 'pea', 'other_plant']);
  assert.deepEqual(lists.water_temp_special, ['cold']);
  assert.deepEqual(files.brew.ranges.dose_g, { minimum: 5, maximum: 100, multipleOf: 0.1 });
  assert.deepEqual(files.brew.ranges.water_g, { minimum: 10, maximum: 1500, multipleOf: 1 });
  assert.deepEqual(files.brew.ranges.water_temp_c, { minimum: 80, maximum: 100, multipleOf: 1 });
  assert.equal(files.brew.ranges.grind_normalised.minimum, 1);
  assert.equal(files.brew.ranges.grind_normalised.maximum, 10);
  // F3
  assert.deepEqual(lists.criteria, [
    'aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall',
  ]);
  assert.deepEqual(files.criteria.scale, { minimum: 1, maximum: 10, multipleOf: 0.5 });
  assert.deepEqual(lists.intensity_dimensions, ['acidity', 'body', 'bitterness']);
  assert.deepEqual(lists.intensity_levels, ['low', 'medium', 'high']);
  assert.equal(files.flavour_notes.max_picks, 5);
  // F1
  assert.deepEqual(files.shelf.bag_sizes.map((size) => size.grams), [250, 500, 1000]);
  // Lists the acceptance criteria require to exist.
  for (const namespace of ['processes', 'roast_levels', 'price_bands']) {
    assert.ok(lists[namespace]?.length > 0, `${namespace} is missing`);
  }
});

test('v1 flavour notes: two levels, about 80 terms, spec examples present, published', () => {
  const { flavour_notes: file } = loadVocabulary(1);
  const count = file.flavour_categories.reduce((sum, category) => sum + category.flavour_notes.length, 0);
  assert.ok(count >= 70 && count <= 90, `expected about 80 notes, found ${count}`);
  const notesOf = (id) => file.flavour_categories.find((c) => c.id === id).flavour_notes.map((n) => n.id);
  assert.ok(notesOf('fruity').includes('berry'));
  assert.ok(notesOf('nutty').includes('hazelnut'));
  // The owner approved v1, flavour notes included, on 2026-11-25
  // (vocabulary/CHANGELOG.md). v1 is published and locked by v1.lock.json.
  assert.equal(file.status, 'published');
});

test('v1: every file is published', () => {
  const files = loadVocabulary(1);
  for (const [name, file] of Object.entries(files)) assert.equal(file.status, 'published', `${name}.json`);
});

test('every vocabulary id has a non-empty label in every language, and no label is orphaned', () => {
  const lists = mergeIdLists(versions.map((version) => collectIds(loadVocabulary(version)).lists));
  const i18n = loadI18n();
  assert.deepEqual(Object.keys(i18n).sort(), [...LANGUAGES].sort());
  for (const lang of LANGUAGES) {
    assert.deepEqual(checkI18n(lang, i18n[lang], lists), []);
  }
});

// ---- The checks themselves must be able to fail. ----

test('schema check fails: file without a schema', () => {
  const fixture = { version: 1, status: 'published', zz_test_fixture: [{ id: 'x' }] };
  const files = { ...loadVocabulary(1), zz_test_fixture: fixture };
  assert.deepEqual(validateVocabulary(files, schemas, 1), ['zz_test_fixture.json: no schema zz_test_fixture.schema.json']);
});

test('schema check fails: schema without a file', () => {
  const { bean, ...files } = loadVocabulary(1);
  assert.deepEqual(validateVocabulary(files, schemas, 1), ['bean.schema.json: no vocabulary file bean.json']);
});

test('schema check fails: bad id, display text, unknown property, missing step, wrong version', () => {
  const broken = (mutate) => {
    const files = clone(loadVocabulary(1));
    mutate(files);
    return validateVocabulary(files, schemas, 1);
  };
  assert.notDeepEqual(broken((f) => { f.brew.methods[0].id = 'Espresso'; }), []);
  assert.notDeepEqual(broken((f) => { f.brew.methods[0].id = 'french-press'; }), []);
  assert.notDeepEqual(broken((f) => { f.brew.methods[0].label = 'Espresso'; }), []);
  assert.notDeepEqual(broken((f) => { f.brew.methods = ['espresso']; }), []);
  assert.notDeepEqual(broken((f) => { delete f.brew.ranges.dose_g.multipleOf; }), []);
  assert.notDeepEqual(broken((f) => { delete f.brew.ranges.brew_time_s; }), []);
  assert.notDeepEqual(broken((f) => { f.criteria.status = 'final'; }), []);
  assert.notDeepEqual(broken((f) => { f.bean.roast_levels = []; }), []);
  assert.notDeepEqual(broken((f) => { delete f.shelf.bag_sizes[0].grams; }), []);
  assert.notDeepEqual(broken((f) => { f.flavour_notes.flavour_categories[0].flavour_notes = []; }), []);
  assert.notDeepEqual(broken((f) => { f.flavour_notes.comment = 'free text'; }), []);
  assert.deepEqual(broken((f) => { f.bean.version = 2; }), ['bean.json: version 2 does not match directory v1']);
});

test('id check fails: duplicate within a list, across categories, and a list in two files', () => {
  const files = clone(loadVocabulary(1));
  files.brew.methods.push({ id: 'espresso' });
  files.flavour_notes.flavour_categories[1].flavour_notes.push({ id: 'berry' });
  files.bean.methods = [{ id: 'drip' }];
  assert.deepEqual(collectIds(files).problems, [
    'methods: defined in both bean.json and brew.json',
    'methods: duplicate id espresso',
    'flavour_notes: duplicate id berry',
  ]);
});

test('id check passes: the same id in two different lists is allowed', () => {
  // "acidity" is a criterion and an intensity dimension; "honey" a process and a note.
  const { lists, problems } = collectIds(loadVocabulary(1));
  assert.deepEqual(problems, []);
  assert.ok(lists.criteria.includes('acidity') && lists.intensity_dimensions.includes('acidity'));
});

test('label check fails: missing, empty and orphan labels and questions', () => {
  const lists = collectIds(loadVocabulary(1)).lists;
  const en = clone(loadI18n().en);
  delete en.labels.methods.espresso;
  en.labels.water_types.tap = '  ';
  en.labels.methods.pour_over = 'Pour over';
  en.labels.zz_test_fixture = { x: 'Fixture' };
  delete en.labels.price_bands;
  delete en.questions.criteria.aroma;
  en.questions.criteria.bitterness = 'How bitter?';
  const problems = checkI18n('en', en, lists);
  for (const expected of [
    'en: missing label methods.espresso',
    'en: empty label water_types.tap',
    'en: orphan label methods.pour_over',
    'en: orphan label namespace zz_test_fixture',
    'en: missing label price_bands.under_15',
    'en: missing question criteria.aroma',
    'en: orphan question criteria.bitterness',
  ]) {
    assert.ok(problems.includes(expected), `expected problem: ${expected}`);
  }
});

test('label check fails: a new vocabulary id without labels', () => {
  const files = clone(loadVocabulary(1));
  files.brew.methods.push({ id: 'pour_over_cone' });
  const lists = collectIds(files).lists;
  const i18n = loadI18n();
  assert.deepEqual(checkI18n('en', i18n.en, lists), ['en: missing label methods.pour_over_cone']);
  assert.deepEqual(checkI18n('de', i18n.de, lists), ['de: missing label methods.pour_over_cone']);
});

test('label check fails: missing language file or wrong language tag', () => {
  const lists = collectIds(loadVocabulary(1)).lists;
  assert.deepEqual(checkI18n('de', undefined, lists), ['de: language file is missing']);
  assert.ok(checkI18n('de', loadI18n().en, lists).includes('de: "language" is "en"'));
});

test('semantic check fails: off-step range, overlapping price bands, mixed status', () => {
  const files = clone(loadVocabulary(1));
  files.brew.ranges.grind_normalised.maximum = 10.2;
  files.shelf.price_bands[1].maximum_exclusive = 35;
  files.shelf.bag_sizes[1].grams = 250;
  files.bean.status = 'draft';
  assert.deepEqual(checkSemantics(files), [
    'range grind_normalised: minimum and maximum are not on the step 0.5',
    'bag_sizes: duplicate grams value',
    'price_bands: gap or overlap between from_15_to_30 and from_30_to_45',
    'status: files of one version must share one status',
  ]);
});

test('id check fails: an array of strings or other non-objects, even with a lax schema', () => {
  // A lax schema accepts anything, so only collectIds can catch these.
  const laxSchemas = { ...schemas, zz_test_fixture: { $id: 'zz_test_fixture.schema.json' } };
  const withFixture = (body) => ({
    ...clone(loadVocabulary(1)),
    zz_test_fixture: { version: 1, status: 'published', ...body },
  });
  const cases = [
    [{ zz_test_fixture: ['a', 'b'] }, '/zz_test_fixture'],
    [{ zz_test_fixture: [1, 2] }, '/zz_test_fixture'],
    [{ zz_test_fixture: [[{ id: 'a' }]] }, '/zz_test_fixture'],
    [{ zz_test_fixture: [{ id: 'a' }, 'b'] }, '/zz_test_fixture'],
    [{ zz_test_fixture: [{ name: 'a' }] }, '/zz_test_fixture'],
    [{ zz_test_fixture: [] }, '/zz_test_fixture'],
    [{ nested: { zz_test_fixture: [null] } }, '/nested/zz_test_fixture'],
  ];
  for (const [body, path] of cases) {
    const files = withFixture(body);
    assert.deepEqual(validateVocabulary(files, laxSchemas, 1), [], 'the lax schema lets it through');
    assert.ok(
      collectIds(files).problems.includes(`zz_test_fixture.json: ${path} is not a list of objects with an id`),
      JSON.stringify(body),
    );
  }
  assert.ok(collectIds({ zz_test_fixture: ['a'] }).problems.includes('zz_test_fixture.json: top level is an array, not an object'));
});

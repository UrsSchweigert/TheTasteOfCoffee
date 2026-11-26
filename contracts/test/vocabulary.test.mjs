import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_RANGES,
  LANGUAGES,
  SCALED_FIELDS,
  UNSCALED_IDS,
  checkEntryRanges,
  checkFieldRules,
  checkI18n,
  checkParentReferences,
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
import { loadOpenApi } from '../lib/openapi.mjs';

const schemas = loadSchemas();
const versions = listVersions();
const clone = (value) => structuredClone(value);
/** Id lists merged over every version, drafts included: what the labels must cover. */
const allLists = () => mergeIdLists(versions.map((version) => collectIds(loadVocabulary(version)).lists));

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
  // Drafts included: a draft version cannot be published without its labels.
  const lists = allLists();
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
  assert.deepEqual(broken((f) => { f.criteria.version = 2; }), ['criteria.json: version 2 does not match directory v1']);
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
  const lists = mergeIdLists([allLists(), collectIds(files).lists]);
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

// ---- Vocabulary v2 (ADR 0006, amended by ADR 0011): published on 2026-11-25. ----

const withoutMeta = ({ version, status, ...rest }) => rest;
const v2Entries = (namespace) => loadVocabulary(2).bean[namespace];

test('v2 is published in every file (owner-approved with the ADR 0011 amendments)', () => {
  const files = loadVocabulary(2);
  for (const [name, file] of Object.entries(files)) assert.equal(file.status, 'published', `${name}.json`);
});

test('v2 is v1 plus the origins, species and varieties lists in bean.json, and nothing else changed', () => {
  const v1 = loadVocabulary(1);
  const v2 = loadVocabulary(2);
  assert.deepEqual(Object.keys(v2), Object.keys(v1));
  for (const name of Object.keys(v1)) {
    const expected = withoutMeta(v1[name]);
    const actual = withoutMeta(v2[name]);
    if (name === 'bean') {
      const { origins, species, varieties, ...rest } = actual;
      assert.deepEqual(rest, expected, 'bean.json: v1 lists unchanged');
      assert.ok(origins && species && varieties, 'bean.json: origins, species and varieties added');
    } else {
      assert.deepEqual(actual, expected, `${name}.json`);
    }
  }
});

test('no version drops or renames an id of the version before it (that needs an ADR)', () => {
  for (const version of versions.slice(1)) {
    const before = collectIds(loadVocabulary(version - 1)).lists;
    const after = collectIds(loadVocabulary(version)).lists;
    for (const [namespace, ids] of Object.entries(before)) {
      const missing = ids.filter((id) => !(after[namespace] ?? []).includes(id));
      assert.deepEqual(missing, [], `v${version} ${namespace}`);
    }
  }
});

test('v2 origins and varieties: well-known sets, ending with other and unknown', () => {
  const { lists } = collectIds(loadVocabulary(2));
  assert.equal(lists.origins.length, 56);
  assert.equal(lists.varieties.length, 36);
  assert.deepEqual(lists.origins.slice(-3), ['blend', 'other', 'unknown']);
  assert.deepEqual(lists.varieties.slice(-3), ['mixed', 'other', 'unknown']);
  for (const id of ['ethiopia', 'kenya', 'brazil', 'colombia', 'costa_rica', 'guatemala', 'indonesia', 'yemen']) {
    assert.ok(lists.origins.includes(id), id);
  }
  for (const id of ['typica', 'bourbon', 'caturra', 'catuai', 'geisha', 'sl28', 'sl34', 'pacamara', 'castillo', 'heirloom', 'mundo_novo']) {
    assert.ok(lists.varieties.includes(id), id);
  }
});

test('v2 holds the owner amendments of ADR 0011', () => {
  const { lists } = collectIds(loadVocabulary(2));
  for (const id of ['madagascar', 'togo', 'australia', 'usa', 'bali', 'flores']) assert.ok(lists.origins.includes(id), id);
  for (const id of ['red_bourbon', 'java', 'parainema', 'obata', 'marsellesa', 'catucai', 'ethiopia_74110', 'ethiopia_74112', 'sl14']) {
    assert.ok(lists.varieties.includes(id), id);
  }
  // Robusta is a species, not a cultivar: varieties lists Arabica cultivars only.
  assert.ok(!lists.varieties.includes('robusta'));
  assert.deepEqual(lists.species, ['arabica', 'robusta', 'liberica', 'excelsa', 'arabica_robusta_blend', 'unknown']);
  // `java` is an origin (the island) and a variety (the cultivar): separate namespaces.
  assert.ok(lists.origins.includes('java') && lists.varieties.includes('java'));
});

test('v2 regions name their country, and only the regions do', () => {
  const regions = Object.fromEntries(v2Entries('origins').filter((entry) => 'country' in entry).map((entry) => [entry.id, entry.country]));
  assert.deepEqual(regions, {
    hawaii: 'usa',
    sumatra: 'indonesia',
    java: 'indonesia',
    sulawesi: 'indonesia',
    bali: 'indonesia',
    flores: 'indonesia',
  });
  // A country entry follows the regions' order rule: it comes before its regions.
  const ids = v2Entries('origins').map((entry) => entry.id);
  for (const [region, country] of Object.entries(regions)) assert.ok(ids.indexOf(country) < ids.indexOf(region), region);
});

for (const version of versions) {
  test(`v${version}: every parent reference names a top-level entry of the same list`, () => {
    assert.deepEqual(checkParentReferences(loadVocabulary(version)), []);
  });
}

test('parent check fails: unknown parent, a region as parent, self reference, and the attribute in another list', () => {
  const files = clone(loadVocabulary(2));
  const origin = (id) => files.bean.origins.find((entry) => entry.id === id);
  origin('sumatra').country = 'atlantis';
  origin('bali').country = 'java';
  origin('kenya').country = 'kenya';
  origin('flores').country = 7;
  files.bean.varieties[0].country = 'ethiopia';
  assert.deepEqual(checkParentReferences(files), [
    'origins.kenya: country names the entry itself',
    'origins.sumatra: country "atlantis" is not an entry of origins',
    'origins.bali: country java has a country itself; a parent must be top level',
    'origins.flores: country 7 is not an entry of origins',
    'varieties.typica: country is only allowed in origins',
  ]);
});

test('parent check fails: a catch-all id (blend, other, unknown) as a country', () => {
  const files = clone(loadVocabulary(2));
  const origin = (id) => files.bean.origins.find((entry) => entry.id === id);
  origin('sumatra').country = 'unknown';
  origin('java').country = 'blend';
  origin('bali').country = 'other';
  assert.deepEqual(checkParentReferences(files), [
    'origins.sumatra: country unknown is a catch-all entry, not a parent',
    'origins.java: country blend is a catch-all entry, not a parent',
    'origins.bali: country other is a catch-all entry, not a parent',
  ]);
});

test('schema check: bean.json needs origins, species and varieties from v2 on, and v1 has none of them', () => {
  const missing = (name) => {
    const v2 = clone(loadVocabulary(2));
    delete v2.bean[name];
    return validateVocabulary(v2, schemas, 2);
  };
  for (const name of ['origins', 'species', 'varieties']) {
    assert.ok(missing(name).includes(`bean.json: / must have required property '${name}'`), name);
  }
  for (const name of ['origins', 'species', 'varieties']) {
    const v1 = clone(loadVocabulary(1));
    v1.bean[name] = [{ id: 'unknown' }];
    assert.notDeepEqual(validateVocabulary(v1, schemas, 1), [], name);
  }
  const badId = clone(loadVocabulary(2));
  badId.bean.origins.push({ id: 'Ethiopia Guji' });
  assert.notDeepEqual(validateVocabulary(badId, schemas, 2), []);
});

test('schema check: country is optional, an id, and only allowed on origins', () => {
  const broken = (mutate) => {
    const files = clone(loadVocabulary(2));
    mutate(files.bean);
    return validateVocabulary(files, schemas, 2);
  };
  assert.deepEqual(broken(() => {}), []);
  assert.notDeepEqual(broken((bean) => { bean.origins[0].country = 'Not An Id'; }), []);
  assert.notDeepEqual(broken((bean) => { bean.origins[0].region = 'x'; }), []);
  assert.notDeepEqual(broken((bean) => { bean.varieties[0].country = 'ethiopia'; }), []);
  assert.notDeepEqual(broken((bean) => { bean.species[0].country = 'ethiopia'; }), []);
  assert.notDeepEqual(broken((bean) => { bean.processes[0].country = 'ethiopia'; }), []);
});

test('label check fails: an origin, species or variety without a label in one language', () => {
  const lists = allLists();
  const en = clone(loadI18n().en);
  const de = clone(loadI18n().de);
  delete en.labels.origins.ethiopia;
  de.labels.varieties.geisha = '';
  delete de.labels.origins;
  delete de.labels.species.excelsa;
  assert.deepEqual(checkI18n('en', en, lists), ['en: missing label origins.ethiopia']);
  const problems = checkI18n('de', de, lists);
  assert.ok(problems.includes('de: empty label varieties.geisha'));
  assert.ok(problems.includes('de: missing label origins.unknown'));
  assert.ok(problems.includes('de: missing label species.excelsa'));
});

test('label check fails: a label left for an id that was removed (robusta under varieties)', () => {
  const en = clone(loadI18n().en);
  en.labels.varieties.robusta = 'Robusta';
  assert.deepEqual(checkI18n('en', en, allLists()), ['en: orphan label varieties.robusta']);
});

// ---- Vocabulary v3 (task M2-T2 to M2-T4, D13): grinders and the method field rules. Published 2026-11-26. ----

for (const version of versions) {
  test(`v${version}: every entry scale sits on its step, and the step is exact in binary`, () => {
    assert.deepEqual(checkEntryRanges(loadVocabulary(version)), []);
  });
}

const brewParameterFields = () => Object.keys(loadOpenApi().components.schemas.BrewParameters.properties);
const ruleFields = () => brewParameterFields();
const v3 = () => clone(loadVocabulary(3));
const methodIds = () => loadVocabulary(3).brew.methods.map((entry) => entry.id);
const allowedBy = (files, field) => Object.keys(files.brew.field_rules[field]?.allowed_methods ?? {});
const except = (...ids) => methodIds().filter((id) => !ids.includes(id));

test('v3 is published in every file, and v1 and v2 are too (the lock test covers the bytes)', () => {
  for (const [name, file] of Object.entries(loadVocabulary(3))) {
    assert.equal(file.version, 3, `${name}.json`);
    assert.equal(file.status, 'published', `${name}.json`);
  }
  for (const version of [1, 2]) {
    for (const file of Object.values(loadVocabulary(version))) assert.equal(file.status, 'published');
  }
});

test('v3 is v2 plus grinders and field_rules in brew.json, unknown in processes and other in species (ADR 0029), and nothing else changed', () => {
  const v2 = loadVocabulary(2);
  const files = loadVocabulary(3);
  assert.deepEqual(Object.keys(files), Object.keys(v2));
  for (const name of Object.keys(v2)) {
    const actual = withoutMeta(files[name]);
    if (name === 'brew') {
      const { grinders, field_rules: fieldRules, ...rest } = actual;
      assert.deepEqual(rest, withoutMeta(v2.brew), 'brew.json: v2 lists and ranges unchanged');
      assert.ok(grinders && fieldRules, 'brew.json: grinders and field_rules added');
    } else if (name === 'bean') {
      const before = withoutMeta(v2.bean);
      const ids = (list) => list.map((entry) => entry.id);
      assert.deepEqual(ids(actual.processes), [...ids(before.processes), 'unknown'], 'processes gain unknown at the end');
      assert.deepEqual(ids(actual.species), [...ids(before.species).slice(0, -1), 'other', 'unknown'], 'species gain other before unknown');
      assert.deepEqual(ids(actual.roast_levels), ids(before.roast_levels), 'roast levels stay a scale without other or unknown');
      const { processes, species, ...rest } = actual;
      const { processes: p2, species: s2, ...rest2 } = before;
      assert.deepEqual(rest, rest2, 'every other bean list is unchanged');
    } else {
      assert.deepEqual(actual, withoutMeta(v2[name]), `${name}.json`);
    }
  }
});

test('v3 grinders: hand and electric models, then pre_ground and other, each with its own scale or none', () => {
  const { grinders } = loadVocabulary(3).brew;
  const ids = grinders.map((entry) => entry.id);
  assert.ok(ids.length >= 17 && ids.length <= 27, `expected 17 to 27 grinders, found ${ids.length}`);
  assert.deepEqual(ids.slice(-2), ['pre_ground', 'other']);
  for (const id of ['comandante_c40', 'onezpresso_jx_pro', 'baratza_encore', 'niche_zero']) assert.ok(ids.includes(id), id);
  // Most models have a scale; a dial that is not in steps of 1 or 0.5 has none.
  assert.ok(grinders.filter((entry) => 'scale' in entry).length >= 12);
  for (const entry of grinders.filter((e) => 'scale' in e)) {
    assert.ok([1, 0.5].includes(entry.scale.multipleOf), `${entry.id}: step ${entry.scale.multipleOf}`);
  }
});

test('v3: pre_ground and other have no scale', () => {
  assert.deepEqual(UNSCALED_IDS, ['pre_ground', 'other']);
  const byId = new Map(loadVocabulary(3).brew.grinders.map((entry) => [entry.id, entry]));
  for (const id of UNSCALED_IDS) {
    assert.ok(byId.has(id), `${id} is a grinder`);
    assert.ok(!('scale' in byId.get(id)), `${id} has no scale`);
  }
});

test('v3 field rules are the D13 decision (ADR 0021)', () => {
  const files = loadVocabulary(3);
  assert.deepEqual(Object.keys(files.brew.field_rules).sort(), ['grind_setting', 'grinder', 'water_temp_c', 'water_temp_special']);
  assert.deepEqual(allowedBy(files, 'water_temp_special'), ['cold_brew']);
  assert.deepEqual(allowedBy(files, 'water_temp_c'), except('cold_brew', 'moka_pot', 'cezve'));
  assert.deepEqual(allowedBy(files, 'grinder'), except('fully_automatic'));
  assert.deepEqual(allowedBy(files, 'grind_setting'), except('fully_automatic'));
  // Every other field is allowed with every method.
  for (const field of ['dose_dg', 'water_g', 'brew_time_s', 'grind_normalised', 'water_type', 'milk']) {
    assert.ok(!(field in files.brew.field_rules), field);
  }
});

for (const version of versions.filter((v) => v >= 3)) {
  test(`v${version}: every method field rule names a known method and field, and grind_setting needs grinder`, () => {
    assert.deepEqual(checkFieldRules(loadVocabulary(version), { fields: ruleFields() }), []);
  });
}

test('v3: every rule names a known method and a known BrewParameters field, never method', () => {
  assert.deepEqual(checkFieldRules(loadVocabulary(3), { fields: ruleFields() }), []);
  for (const field of Object.keys(loadVocabulary(3).brew.field_rules)) {
    assert.ok(ruleFields().includes(field) && field !== 'method', field);
  }
});

test('the fields v3 adds are in the API, because v3 is published', () => {
  for (const field of ['grinder', 'grind_setting']) assert.ok(brewParameterFields().includes(field), field);
});

test('the grinder scale binding: SCALED_FIELDS and ENTRY_RANGES name v3 lists and fields', () => {
  assert.deepEqual(ENTRY_RANGES, { grinders: 'scale' });
  assert.deepEqual(SCALED_FIELDS, { grind_setting: { by: 'grinder', list: 'grinders' } });
  const { lists } = collectIds(loadVocabulary(3));
  for (const [field, { by, list }] of Object.entries(SCALED_FIELDS)) {
    assert.ok(list in ENTRY_RANGES && list in lists, list);
    assert.ok(ruleFields().includes(field) && ruleFields().includes(by), `${field}, ${by}`);
  }
});

test('field rule check fails: unknown method or field, method itself, empty, all methods, order, not true', () => {
  const fields = ruleFields();
  const check = (mutate) => {
    const files = v3();
    mutate(files.brew.field_rules, files);
    return checkFieldRules(files, { fields });
  };
  assert.deepEqual(check((r) => { r.water_temp_special.allowed_methods.pour_over = true; }), ['field_rules.water_temp_special: pour_over is not a method']);
  assert.deepEqual(check((r) => { r.grind_size = { allowed_methods: { espresso: true } }; }), ['field_rules.grind_size: grind_size is not a BrewParameters field']);
  assert.deepEqual(check((r) => { r.method = { allowed_methods: { espresso: true } }; }), ['field_rules.method: the method is never ruled by a method']);
  assert.deepEqual(check((r) => { r.milk = { allowed_methods: {} }; }), ['field_rules.milk: allows no method']);
  assert.deepEqual(check((r) => { r.milk = { allowed_methods: Object.fromEntries(methodIds().map((m) => [m, true])) }; }), ['field_rules.milk: allows every method; drop the rule']);
  assert.deepEqual(check((r) => { r.water_temp_c.allowed_methods = { v60: true, espresso: true }; }), ['field_rules.water_temp_c: methods are not in the order of the method list']);
  assert.deepEqual(check((r) => { r.water_temp_special.allowed_methods.cold_brew = false; }), ['field_rules.water_temp_special: cold_brew must be true']);
  assert.deepEqual(check((r) => { r.milk = { methods: ['espresso'] }; }), ['field_rules.milk: allowed_methods is missing or not an object']);
  // A method removed from the list makes every rule that names it fail.
  const files = v3();
  files.brew.methods = files.brew.methods.filter((entry) => entry.id !== 'cold_brew');
  assert.ok(checkFieldRules(files, { fields }).includes('field_rules.water_temp_special: cold_brew is not a method'));
});

test('field rule check fails: grind_setting allowed where grinder is not, or without the grinder list', () => {
  const fields = ruleFields();
  const files = v3();
  files.brew.field_rules.grinder.allowed_methods = { espresso: true };
  assert.deepEqual(checkFieldRules(files, { fields }), [
    'field_rules.grind_setting: allowed with moka_pot, v60, chemex, kalita, batch_filter, aeropress, french_press, cold_brew, cezve, siphon, where grinder is not',
  ]);
  const noRule = v3();
  delete noRule.brew.field_rules.grind_setting;
  assert.deepEqual(checkFieldRules(noRule, { fields }), ['field_rules.grind_setting: allowed with fully_automatic, where grinder is not']);
  const noList = v3();
  delete noList.brew.grinders;
  assert.deepEqual(checkFieldRules(noList, { fields }), ['field_rules.grind_setting: depends on the list grinders, which brew.json does not define']);
});

test('entry range check fails: off step, inexact step, empty, not a range, on pre_ground or other, on another list', () => {
  const check = (mutate) => {
    const files = v3();
    const grinder = (id) => files.brew.grinders.find((entry) => entry.id === id);
    mutate(grinder, files);
    return checkEntryRanges(files);
  };
  assert.deepEqual(check((g) => { g('niche_zero').scale.maximum = 50.25; }), ['grinders.niche_zero: scale minimum and maximum are not on the step 0.5']);
  assert.deepEqual(check((g) => { g('baratza_encore').scale = { minimum: 1, maximum: 4, multipleOf: 0.1 }; }), ['grinders.baratza_encore: scale step 0.1 is not exact in binary floating point (ADR 0004)']);
  assert.deepEqual(check((g) => { g('baratza_encore').scale.minimum = 40; }), ['grinders.baratza_encore: scale minimum is not below maximum']);
  assert.deepEqual(check((g) => { g('baratza_encore').scale = { minimum: 1, maximum: 40 }; }), ['grinders.baratza_encore: scale is not a range { minimum, maximum, multipleOf }']);
  assert.deepEqual(check((g) => { g('pre_ground').scale = { minimum: 1, maximum: 10, multipleOf: 1 }; }), ['grinders.pre_ground: scale is not allowed; pre_ground has no scale']);
  assert.deepEqual(check((g) => { g('other').scale = { minimum: 1, maximum: 10, multipleOf: 1 }; }), ['grinders.other: scale is not allowed; other has no scale']);
  assert.deepEqual(check((g, f) => { f.brew.methods[0].scale = { minimum: 1, maximum: 10, multipleOf: 1 }; }), ['methods.espresso: scale is only allowed in grinders']);
});

test('schema check: grinders and field_rules are required from v3 on, forbidden before, and closed', () => {
  const broken = (mutate) => {
    const files = v3();
    mutate(files.brew);
    return validateVocabulary(files, schemas, 3);
  };
  assert.deepEqual(broken(() => {}), []);
  for (const name of ['grinders', 'field_rules']) {
    assert.ok(broken((brew) => { delete brew[name]; }).includes(`brew.json: / must have required property '${name}'`), name);
    const v2 = clone(loadVocabulary(2));
    v2.brew[name] = loadVocabulary(3).brew[name];
    assert.notDeepEqual(validateVocabulary(v2, schemas, 2), [], `${name} in v2`);
  }
  assert.notDeepEqual(broken((brew) => { brew.grinders[0].scale.multipleOf = 0; }), [], 'step must be positive');
  assert.notDeepEqual(broken((brew) => { delete brew.grinders[0].scale.maximum; }), [], 'scale is a full range');
  assert.notDeepEqual(broken((brew) => { brew.grinders[0].label = 'Comandante'; }), [], 'no display text');
  assert.notDeepEqual(broken((brew) => { brew.grinders[0].clicks = 40; }), [], 'no other attribute');
  assert.notDeepEqual(broken((brew) => { brew.methods[0].scale = { minimum: 1, maximum: 2, multipleOf: 1 }; }), [], 'scale only on grinders');
  assert.notDeepEqual(broken((brew) => { brew.field_rules.water_temp_c.allowed_methods.espresso = 'yes'; }), [], 'allowed is true');
  assert.notDeepEqual(broken((brew) => { brew.field_rules.WaterTemp = { allowed_methods: { espresso: true } }; }), [], 'field is snake_case');
  assert.notDeepEqual(broken((brew) => { brew.field_rules.water_temp_c.excluded_methods = { cezve: true }; }), [], 'no other rule kind');
  assert.notDeepEqual(broken((brew) => { brew.field_rules = {}; }), [], 'not empty');
  assert.notDeepEqual(broken((brew) => { brew.grinders.push({ id: '1zpresso_jx' }); }), [], 'ids start with a letter');
});

test('label check fails: a grinder without a label in one language', () => {
  const lists = allLists();
  const de = clone(loadI18n().de);
  delete de.labels.grinders.pre_ground;
  assert.deepEqual(checkI18n('de', de, lists), ['de: missing label grinders.pre_ground']);
});

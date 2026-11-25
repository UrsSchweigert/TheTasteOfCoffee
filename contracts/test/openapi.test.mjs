import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkOpenApi,
  checkStructure,
  checkVocabularyBindings,
  compileComponentSchemas,
  findIdentityFields,
  lintSchemas,
  loadOpenApi,
  loadVocabularyContext,
  parseOpenApi,
} from '../lib/openapi.mjs';
import { loadVocabulary } from '../lib/vocabulary.mjs';

const doc = loadOpenApi();
const context = loadVocabularyContext();
const clone = (value) => structuredClone(value);
const broken = (mutate) => {
  const copy = clone(doc);
  mutate(copy);
  return copy;
};
const hasProblem = (problems, fragment) => problems.some((problem) => problem.includes(fragment));
const assertProblem = (problems, fragment) =>
  assert.ok(hasProblem(problems, fragment), `expected a problem containing "${fragment}", got:\n${problems.join('\n')}`);
const schemas = (d) => d.components.schemas;

// ---- The real document ----

test('openapi.yaml is structurally valid OpenAPI 3.1', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(checkStructure(doc), []);
});

test('openapi.yaml: no free-text string, no unbounded number, no open object', () => {
  assert.deepEqual(lintSchemas(doc), []);
});

test('openapi.yaml: no field, parameter or path segment names a user', () => {
  assert.deepEqual(findIdentityFields(doc), []);
});

test('openapi.yaml: enums, ranges and limits equal vocabulary v1', () => {
  assert.equal(context.latestPublished, 1);
  assert.deepEqual(checkVocabularyBindings(doc, context), []);
});

test('openapi.yaml: all checks together, as the CLI runs them', () => {
  assert.deepEqual(checkOpenApi(doc, context), []);
});

test('openapi.yaml defines the routes of task M0-T2, all behind the bearer token', () => {
  const expected = [
    'GET /barcodes/{barcode}',
    'POST /beans', 'GET /beans/{bean_id}',
    'GET /shelf', 'POST /shelf', 'GET /shelf/{shelf_entry_id}', 'PUT /shelf/{shelf_entry_id}', 'DELETE /shelf/{shelf_entry_id}',
    'GET /brews', 'POST /brews', 'GET /brews/{brew_id}', 'PUT /brews/{brew_id}', 'DELETE /brews/{brew_id}',
    'GET /recipes', 'POST /recipes', 'GET /recipes/{recipe_id}', 'PUT /recipes/{recipe_id}', 'DELETE /recipes/{recipe_id}',
    'GET /profile', 'PUT /profile',
    'GET /export',
    'DELETE /account',
  ];
  const actual = Object.entries(doc.paths).flatMap(([route, item]) =>
    ['get', 'put', 'post', 'delete', 'patch'].filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${route}`));
  assert.deepEqual(actual.sort(), expected.sort());
  assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) assert.equal(op.security, undefined, `${op.operationId} overrides security`);
  }
});

test('openapi.yaml: the export returns CSV only', () => {
  const content = doc.paths['/export'].get.responses['200'].content;
  assert.deepEqual(Object.keys(content), ['text/csv']);
  assert.deepEqual(content['text/csv'].schema, { type: 'string', contentMediaType: 'text/csv' });
});

test('openapi.yaml: ranges match v1 exactly (dose as integer decigrams)', () => {
  const { brew, criteria, flavour_notes: notes } = loadVocabulary(1);
  const s = schemas(doc);
  assert.deepEqual(brew.ranges.dose_g, { minimum: 5, maximum: 100, multipleOf: 0.1 });
  assert.deepEqual([s.DoseDg.type, s.DoseDg.minimum, s.DoseDg.maximum, s.DoseDg.multipleOf], ['integer', 50, 1000, undefined]);
  assert.deepEqual([s.WaterG.minimum, s.WaterG.maximum], [brew.ranges.water_g.minimum, brew.ranges.water_g.maximum]);
  assert.deepEqual([s.WaterTempC.minimum, s.WaterTempC.maximum], [80, 100]);
  assert.deepEqual([s.BrewTimeS.minimum, s.BrewTimeS.maximum], [brew.ranges.brew_time_s.minimum, brew.ranges.brew_time_s.maximum]);
  assert.deepEqual([s.GrindNormalised.minimum, s.GrindNormalised.maximum, s.GrindNormalised.multipleOf], [1, 10, 0.5]);
  assert.deepEqual([s.Score.minimum, s.Score.maximum, s.Score.multipleOf], [criteria.scale.minimum, criteria.scale.maximum, criteria.scale.multipleOf]);
  assert.equal(s.Rating.properties.flavour_notes.maxItems, notes.max_picks);
  assert.equal(notes.max_picks, 5);
});

// ---- The schemas accept and reject what the specification says ----

const validate = compileComponentSchemas(doc);
const ID = '01JD8Z5Y3V9Q6M2K4N7P8R0S1T';
const validBrew = () => ({
  vocabulary_version: 1,
  shelf_entry_id: ID,
  brewed_at: '2026-11-25T08:30:00Z',
  parameters: {
    method: 'v60', dose_dg: 150, water_g: 250, water_temp_c: 94, brew_time_s: 180,
    grind_normalised: 4.5, water_type: 'filtered', milk: 'oat',
  },
  rating: {
    scores: { aroma: 7.5, flavour: 8, aftertaste: 6.5, acidity: 7, body: 6, sweetness: 7, balance: 7.5, overall: 8 },
    intensities: { acidity: 'high', body: 'medium', bitterness: 'low' },
    flavour_notes: ['berry', 'cocoa', 'jasmine'],
    buy_again: true,
  },
});

test('schemas accept valid payloads', () => {
  assert.deepEqual(validate('BrewInput', validBrew()), []);
  assert.deepEqual(validate('BrewInput', { vocabulary_version: 1, shelf_entry_id: ID, brewed_at: '2026-11-25T08:30:00+01:00', parameters: { method: 'cold_brew', water_temp_special: 'cold' } }), []);
  assert.deepEqual(validate('RecipeInput', { vocabulary_version: 1, parameters: { method: 'espresso', dose_dg: 50 } }), []);
  assert.deepEqual(validate('RecipeInput', { vocabulary_version: 1, parameters: { method: 'espresso', dose_dg: 1000 } }), []);
  assert.deepEqual(validate('ShelfEntryInput', { vocabulary_version: 1, bean_id: ID, purchase_date: '2026-11-20', roast_date: '2026-11-10', bag_size: 'g_250', price_band: 'from_30_to_45' }), []);
  assert.deepEqual(validate('BeanCreate', { vocabulary_version: 1, barcode: '4006381333931', open_food_facts_confirmed: true, attributes: {} }), []);
  assert.deepEqual(validate('BeanCreate', { vocabulary_version: 1, attributes: { process: 'washed', roast_level: 'medium_light' } }), []);
  assert.deepEqual(validate('Profile', { locale: 'de', consent: { contribute_to_aggregates: false } }), []);
  assert.deepEqual(validate('Barcode', '036000291452'), []);
});

test('schemas reject what the specification forbids', () => {
  const rejects = (name, value, why) => assert.notDeepEqual(validate(name, value), [], why);
  const brewWith = (mutate) => {
    const value = validBrew();
    mutate(value);
    return value;
  };
  rejects('BrewInput', brewWith((b) => { b.note = 'tasty'; }), 'unknown property');
  rejects('BrewInput', brewWith((b) => { b.user_id = 'abc'; }), 'user id in the body');
  rejects('BrewInput', brewWith((b) => { delete b.vocabulary_version; }), 'missing vocabulary version');
  rejects('BrewInput', brewWith((b) => { b.vocabulary_version = 2; }), 'unpublished vocabulary version');
  rejects('BrewInput', brewWith((b) => { delete b.parameters.method; }), 'method is required');
  rejects('BrewInput', brewWith((b) => { b.parameters.method = 'pour_over'; }), 'unknown method');
  rejects('BrewInput', brewWith((b) => { b.parameters.dose_dg = 49; }), 'dose below 5.0 g');
  rejects('BrewInput', brewWith((b) => { b.parameters.dose_dg = 1001; }), 'dose above 100.0 g');
  rejects('BrewInput', brewWith((b) => { b.parameters.dose_dg = 15.5; }), 'dose is integer decigrams');
  rejects('BrewInput', brewWith((b) => { b.parameters.water_g = 1501; }), 'water above range');
  rejects('BrewInput', brewWith((b) => { b.parameters.water_temp_c = 79; }), 'temperature below range');
  rejects('BrewInput', brewWith((b) => { b.parameters.water_temp_special = 'cold'; }), 'temperature and cold together');
  rejects('BrewInput', brewWith((b) => { b.parameters.brew_time_s = 0; }), 'brew time below range');
  rejects('BrewInput', brewWith((b) => { b.parameters.grind_normalised = 4.2; }), 'grind off the half step');
  rejects('BrewInput', brewWith((b) => { b.parameters.milk = true; }), 'milk is a pick list, not a toggle (ADR 0003)');
  rejects('BrewInput', brewWith((b) => { b.rating.scores.aroma = 7.3; }), 'score off the half step');
  rejects('BrewInput', brewWith((b) => { b.rating.scores.aroma = 0.5; }), 'score below 1');
  rejects('BrewInput', brewWith((b) => { b.rating.scores.aroma = 10.5; }), 'score above 10');
  rejects('BrewInput', brewWith((b) => { delete b.rating.scores.overall; }), 'a rating scores all eight criteria');
  rejects('BrewInput', brewWith((b) => { b.rating.scores.bitterness = 5; }), 'bitterness is not a criterion');
  rejects('BrewInput', brewWith((b) => { b.rating.intensities.sweetness = 'low'; }), 'sweetness is not an intensity dimension');
  rejects('BrewInput', brewWith((b) => { b.rating.flavour_notes = ['berry', 'cherry', 'plum', 'peach', 'apricot', 'apple']; }), 'six flavour notes');
  rejects('BrewInput', brewWith((b) => { b.rating.flavour_notes = ['berry', 'berry']; }), 'duplicate flavour note');
  rejects('BrewInput', brewWith((b) => { b.rating.flavour_notes = ['fruity']; }), 'a category is not a note');
  rejects('BrewInput', brewWith((b) => { b.brewed_at = 'yesterday'; }), 'timestamp is RFC 3339');
  rejects('BrewInput', brewWith((b) => { b.shelf_entry_id = 'shelf-1'; }), 'ids are ULIDs');
  rejects('Barcode', '12345678901', 'too short');
  rejects('Barcode', '12345678901234', 'too long');
  rejects('Barcode', '40063813339a1', 'not digits');
  rejects('BeanCreate', { vocabulary_version: 1, open_food_facts_confirmed: true, attributes: {} }, 'Open Food Facts hit without barcode');
  rejects('BeanCreate', { vocabulary_version: 1, attributes: { roaster: 'Acme' } }, 'roaster is not in v1');
  rejects('BeanCreate', { vocabulary_version: 1, attributes: {}, name: 'Ethiopia Guji' }, 'no Open Food Facts text');
  rejects('ShelfEntryInput', { vocabulary_version: 1, bean_id: ID, purchase_date: '20.11.2026' }, 'ISO date');
  rejects('ShelfEntryInput', { vocabulary_version: 1, bean_id: ID, purchase_date: '2026-11-20', bag_size: '250g' }, 'bag size id');
  rejects('Profile', { locale: 'fr', consent: { contribute_to_aggregates: true } }, 'no French labels');
  rejects('Profile', { locale: 'de' }, 'consent required');
});

// ---- The checks themselves must be able to fail ----

test('YAML parsing fails on duplicate keys', () => {
  assert.throws(() => parseOpenApi('a: 1\na: 2\n'));
});

test('lint fails: string without enum, pattern or format, at every depth', () => {
  const problems = lintSchemas(broken((d) => {
    const s = schemas(d);
    s.Profile.properties.nickname = { type: 'string' }; // nested property
    s.Rating.properties.tags = { type: 'array', maxItems: 3, items: { type: 'string' } }; // items
    delete s.Method.enum; // a $ref'd component, reached from Brew
    s.Method.description = 'was an enum';
    d.components.parameters.CursorQuery.schema = { type: 'string' }; // parameter
    d.paths['/profile'].get.responses['200'].content['application/json'].schema = { // inline response
      type: 'object', additionalProperties: false, properties: { comment: { type: 'string' } },
    };
  }));
  assertProblem(problems, '#/components/schemas/Profile/properties/nickname: string without enum, pattern or format');
  assertProblem(problems, '#/components/schemas/Rating/properties/tags/items: string without enum, pattern or format');
  assertProblem(problems, '#/components/schemas/Method: string without enum, pattern or format');
  assertProblem(problems, '#/components/parameters/CursorQuery/schema: string without enum, pattern or format');
  assertProblem(problems, '/content/application~1json/schema/properties/comment: string without enum, pattern or format');
});

test('lint fails: weak string constraints', () => {
  const problems = lintSchemas(broken((d) => {
    const s = schemas(d);
    s.Id.pattern = '[0-9A-Z]{26}';
    s.CalendarDate.format = 'text';
    s.Locale.enum = [];
    // contentMediaType is only an exception on a CSV body.
    s.Profile.properties.blob = { type: 'string', contentMediaType: 'text/csv' };
  }));
  assertProblem(problems, '#/components/schemas/Id: pattern [0-9A-Z]{26} is not anchored');
  assertProblem(problems, '#/components/schemas/CalendarDate: format text is not one of date, date-time');
  assertProblem(problems, '#/components/schemas/Locale: enum must be a non-empty list of strings');
  assertProblem(problems, '#/components/schemas/Profile/properties/blob: string without enum, pattern or format');
});

test('lint fails: number or integer without bounds, and a float-unsafe step', () => {
  const problems = lintSchemas(broken((d) => {
    const s = schemas(d);
    delete s.WaterG.maximum;
    delete s.Score.minimum;
    s.Rating.properties.weight = { type: 'number' };
    s.DoseDg = { type: 'number', minimum: 5, maximum: 100, multipleOf: 0.1 };
    d.components.parameters.LimitQuery.schema = { type: 'integer', minimum: 1 };
  }));
  assertProblem(problems, '#/components/schemas/WaterG: integer without maximum');
  assertProblem(problems, '#/components/schemas/Score: number without minimum');
  assertProblem(problems, '#/components/schemas/Rating/properties/weight: number without minimum');
  assertProblem(problems, '#/components/schemas/Rating/properties/weight: number without maximum');
  assertProblem(problems, '#/components/schemas/DoseDg: multipleOf 0.1 is not exact');
  assertProblem(problems, '#/components/parameters/LimitQuery/schema: integer without maximum');
});

test('lint fails: open objects, unbounded arrays, untyped schemas, allOf, bad refs', () => {
  const problems = lintSchemas(broken((d) => {
    const s = schemas(d);
    delete s.Consent.additionalProperties;
    s.Intensities.additionalProperties = true;
    s.Rating.properties.extra = { type: 'object', properties: {} };
    delete s.BrewPage.properties.items.maxItems;
    s.Rating.properties.anything = {};
    s.Profile.properties.mixed = { type: ['string', 'null'], enum: ['a'] };
    s.Profile.properties.merged = { allOf: [{ $ref: '#/components/schemas/Consent' }] };
    s.Profile.properties.dangling = { $ref: '#/components/schemas/Nope' };
    s.Profile.properties.remote = { $ref: 'https://example.com/schema.json' };
    s.Profile.required.push('missing_one');
    s.BrewParameters.not = { type: 'object' };
  }));
  assertProblem(problems, '#/components/schemas/Consent: object without additionalProperties: false');
  assertProblem(problems, '#/components/schemas/Intensities: object without additionalProperties: false');
  assertProblem(problems, '#/components/schemas/Rating/properties/extra: object without additionalProperties: false');
  assertProblem(problems, '#/components/schemas/BrewPage/properties/items: array without maxItems');
  assertProblem(problems, '#/components/schemas/Rating/properties/anything: schema has no type');
  assertProblem(problems, '#/components/schemas/Profile/properties/mixed: type must be one of');
  assertProblem(problems, '#/components/schemas/Profile/properties/merged: allOf is not allowed');
  assertProblem(problems, '#/components/schemas/Profile/properties/dangling: $ref #/components/schemas/Nope does not resolve');
  assertProblem(problems, '#/components/schemas/Profile/properties/remote: $ref "https://example.com/schema.json" is not local');
  assertProblem(problems, '#/components/schemas/Profile: required property missing_one is not defined');
  assertProblem(problems, '#/components/schemas/BrewParameters/not: not may only hold { required: [...] }');
});

test('lint walks schemas reachable only through $ref, not just components', () => {
  // An inline request schema that points into a nested definition.
  const problems = lintSchemas(broken((d) => {
    d.components.requestBodies = { Odd: { content: { 'application/json': { schema: { $ref: '#/components/requestBodies/Odd/x-inner' } } } } };
    d.components.requestBodies.Odd['x-inner'] = { type: 'object', additionalProperties: false, properties: { free: { type: 'string' } } };
  }));
  assertProblem(problems, '#/components/requestBodies/Odd/x-inner/properties/free: string without enum, pattern or format');
});

test('structure check fails on invalid OpenAPI', () => {
  const problems = checkStructure(broken((d) => {
    d.openapi = '3.0.3';
    delete d.info.version;
    d.paths['/profile'].get.security = [];
    d.paths['/brews/{brew_id}'].get.parameters = [];
    d.paths['/recipes'].get.operationId = 'listBrews';
    d.paths['/profile'].put.requestBody.content = { 'text/plain': { schema: { type: 'string', pattern: '^a$' } } };
    delete d.paths['/shelf'].get.responses['401'];
    d.paths['/export'].get.responses['200'].content['text/csv'].schema = { type: 'string', pattern: '^.*$' };
    d.paths['/account'].delete.responses['204'].content = { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } };
    d.paths['/Beans/'] = d.paths['/beans'];
    d.components.schemas.Orphan = { type: 'boolean' };
    d.components.securitySchemes.bearerAuth = { type: 'apiKey', in: 'header', name: 'X-Key' };
  }));
  for (const fragment of [
    'openapi must be 3.1.x',
    'info needs title and version',
    'GET /profile: overrides security',
    'GET /brews/{brew_id}: path parameter brew_id is not declared',
    'GET /recipes: duplicate operationId listBrews',
    'PUT /profile: requestBody must be application/json only',
    'GET /shelf: no 401 response',
    'GET /export 200: a CSV body must be a string with contentMediaType text/csv',
    'DELETE /account 204: must not have content',
    'path /Beans/: must be lowercase segments',
    'components.schemas.Orphan is never used',
    'bearerAuth must be http bearer with bearerFormat JWT',
  ]) assertProblem(problems, fragment);
});

test('identity check fails on a user id in a body, query, path or parameter', () => {
  const problems = findIdentityFields(broken((d) => {
    schemas(d).BrewInput.properties.user_id = { $ref: '#/components/schemas/Id' };
    schemas(d).Profile.properties.sub = { $ref: '#/components/schemas/Id' };
    d.paths['/brews'].get.parameters.push({ name: 'userId', in: 'query', schema: { $ref: '#/components/schemas/Id' } });
    d.paths['/users/{user_id}/brews'] = { get: { operationId: 'x', responses: { 200: { description: 'x' } } } };
  }));
  assertProblem(problems, '#/components/schemas/BrewInput: property user_id');
  assertProblem(problems, '#/components/schemas/Profile: property sub');
  assertProblem(problems, 'GET /brews: parameter userId');
  assertProblem(problems, 'path /users/{user_id}/brews: segment {user_id}');
});

test('vocabulary binding fails when an enum drifts from the vocabulary', () => {
  const problems = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    s.Method.enum = s.Method.enum.filter((id) => id !== 'siphon');
    s.MilkType.enum.push('goat');
    s.WaterType.enum.reverse();
    delete s.RoastLevel['x-vocabulary'];
    s.Process['x-vocabulary'] = 'process';
    s.Locale.enum = ['de', 'en', 'fr'];
    s.Profile.properties.theme = { type: 'string', enum: ['dark'] };
  }), context);
  assertProblem(problems, '#/components/schemas/Method: enum differs from vocabulary methods; missing siphon');
  assertProblem(problems, '#/components/schemas/MilkType: enum differs from vocabulary milk_types; not in vocabulary goat');
  assertProblem(problems, '#/components/schemas/WaterType: enum differs from vocabulary water_types; order differs');
  assertProblem(problems, '#/components/schemas/RoastLevel: enum without x-vocabulary');
  assertProblem(problems, '#/components/schemas/Process: x-vocabulary process is not a vocabulary list');
  assertProblem(problems, '#/components/schemas/Locale: enum differs from the i18n languages de, en');
  assertProblem(problems, '#/components/schemas/Profile/properties/theme: enum without x-vocabulary');
});

test('vocabulary binding fails when the vocabulary changes under the document', () => {
  // A new id in the vocabulary must show up as drift until the enum follows.
  const files = clone(loadVocabulary(1));
  files.brew.methods.push({ id: 'pour_over_cone' });
  files.brew.ranges.dose_g.maximum = 120;
  files.flavour_notes.max_picks = 3;
  const changed = { ...context, published: [{ version: 1, files }], lists: { ...context.lists, methods: files.brew.methods.map((m) => m.id) } };
  const problems = checkVocabularyBindings(doc, changed);
  assertProblem(problems, '#/components/schemas/Method: enum differs from vocabulary methods; missing pour_over_cone');
  assertProblem(problems, '#/components/schemas/DoseDg: bounds 50..1000 differ from vocabulary brew.ranges.dose_g 50..1200 (scaled by 10)');
  assertProblem(problems, '#/components/schemas/Rating/properties/flavour_notes: maxItems 5 differs from vocabulary flavour_notes.max_picks 3');
});

test('vocabulary binding fails on wrong ranges, steps, keys, limits and versions', () => {
  const problems = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    s.DoseDg['x-vocabulary-scale'] = 1;
    s.WaterTempC.maximum = 96;
    s.Score.multipleOf = 0.25;
    s.GrindNormalised.type = 'integer';
    s.BrewTimeS.type = 'number';
    s.Rating.properties.flavour_notes.maxItems = 6;
    s.VocabularyVersion.maximum = 2;
    delete s.Intensities.properties.bitterness;
    s.WaterG['x-vocabulary-rnage'] = 'brew.ranges.water_g';
  }), context);
  assertProblem(problems, '#/components/schemas/DoseDg: bounds 50..1000 differ from vocabulary brew.ranges.dose_g 5..100');
  assertProblem(problems, '#/components/schemas/WaterTempC: bounds 80..96 differ');
  assertProblem(problems, '#/components/schemas/Score: multipleOf 0.25 differs from vocabulary step 0.5');
  assertProblem(problems, '#/components/schemas/GrindNormalised: step 0.5 is fractional, so type must be number');
  assertProblem(problems, '#/components/schemas/BrewTimeS: step 1 is whole, so type must be integer');
  assertProblem(problems, 'maxItems 6 differs from vocabulary flavour_notes.max_picks 5');
  assertProblem(problems, '#/components/schemas/VocabularyVersion: vocabulary version must be an integer from 1 to the latest published version 1');
  assertProblem(problems, '#/components/schemas/Intensities: properties acidity, body differ from vocabulary intensity_dimensions');
  assertProblem(problems, '#/components/schemas/WaterG: unknown keyword x-vocabulary-rnage');
});

test('vocabulary binding fails on a request without its vocabulary version, and on an unused range', () => {
  const problems = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    delete s.RecipeInput.properties.vocabulary_version;
    s.RecipeInput.required = ['parameters'];
    s.ShelfEntryInput.required = s.ShelfEntryInput.required.filter((name) => name !== 'vocabulary_version');
    delete s.BrewParameters.properties.brew_time_s;
    delete s.BrewTimeS;
  }), context);
  assertProblem(problems, 'POST /recipes: request carries vocabulary values but no required vocabulary_version');
  assertProblem(problems, 'PUT /recipes/{recipe_id}: request carries vocabulary values but no required vocabulary_version');
  assertProblem(problems, 'POST /shelf: request carries vocabulary values but no required vocabulary_version');
  assertProblem(problems, 'vocabulary range brew.ranges.brew_time_s is not used by any schema');
});

test('schema compile fails on a misspelt JSON Schema keyword', () => {
  const problems = checkOpenApi(broken((d) => { schemas(d).WaterG.maximun = 1500; }), context);
  assertProblem(problems, 'schemas do not compile as JSON Schema 2020-12');
});

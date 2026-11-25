import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_TEXT_MAX_LENGTH,
  UNAUTHENTICATED_ROUTES,
  buildVocabularyContext,
  checkOpenApi,
  checkStructure,
  checkVocabularyBindings,
  compileComponentSchemas,
  findIdentityFields,
  findRequestFreeText,
  isIdentityName,
  lintSchemas,
  loadOpenApi,
  loadVocabularyContext,
  parseOpenApi,
  patternProblems,
} from '../lib/openapi.mjs';
import { collectIds, loadVocabulary } from '../lib/vocabulary.mjs';

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

test('openapi.yaml: no request body or parameter reaches response-only free text', () => {
  assert.deepEqual(findRequestFreeText(doc), []);
});

test('openapi.yaml: no field, parameter or path segment names a user', () => {
  assert.deepEqual(findIdentityFields(doc), []);
});

test('openapi.yaml: enums, ranges and limits equal the published vocabulary (v1 and v2)', () => {
  assert.equal(context.latestPublished, 2);
  assert.deepEqual(context.published.map((p) => p.version), [1, 2]);
  assert.deepEqual(checkVocabularyBindings(doc, context), []);
});

test('openapi.yaml: all checks together, as the CLI runs them', () => {
  assert.deepEqual(checkOpenApi(doc, context), []);
});

test('openapi.yaml defines the routes of tasks M0-T2 and M1-T8, all behind the bearer token but GET /health', () => {
  const expected = [
    'GET /barcodes/{barcode}', 'GET /barcodes/{barcode}/open_food_facts',
    'GET /health',
    'POST /beans', 'GET /beans/{bean_id}',
    'GET /catalogue_images/{image_id}',
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
  for (const [route, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (route === '/health' && method === 'get') assert.deepEqual(op.security, []);
      else assert.equal(op.security, undefined, `${op.operationId} overrides security`);
    }
  }
  assert.deepEqual(UNAUTHENTICATED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.route}`), ['GET /health']);
});

test('openapi.yaml: GET /health takes no input and returns only {"status":"ok"} (ADR 0007)', () => {
  const op = doc.paths['/health'].get;
  assert.deepEqual(Object.keys(doc.paths['/health']), ['get']);
  assert.equal(op.parameters, undefined);
  assert.equal(op.requestBody, undefined);
  assert.deepEqual(Object.keys(op.responses).sort(), ['200', '429']);
  assert.deepEqual(schemas(doc).HealthStatus, {
    description: schemas(doc).HealthStatus.description,
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'], 'x-health-status': true } },
  });
});

test('openapi.yaml: Open Food Facts name and brand are response-only, length-limited and marked with their source', () => {
  const product = schemas(doc).OpenFoodFactsProduct;
  assert.deepEqual(Object.keys(product.properties), ['name', 'brand', 'image_id']);
  for (const name of ['name', 'brand']) {
    const field = product.properties[name];
    assert.equal(field['x-free-text-from'], 'open_food_facts', name);
    assert.equal(field.readOnly, true, name);
    assert.ok(field.maxLength >= 1 && field.maxLength <= FREE_TEXT_MAX_LENGTH, name);
  }
  // The image is our stored copy, named by a server-generated id (ADR 0011):
  // no URL, and nothing that points the app at Open Food Facts.
  assert.equal(product.properties.image_id.$ref, '#/components/schemas/Id');
  assert.doesNotMatch(JSON.stringify(doc), /openfoodfacts\.org/);
  assert.deepEqual(schemas(doc).Bean.properties.open_food_facts, { $ref: '#/components/schemas/OpenFoodFactsProduct' });
  assert.equal(schemas(doc).BeanCreate.properties.open_food_facts, undefined);
  assert.equal(schemas(doc).BeanAttributes.properties.name, undefined);
});

test('openapi.yaml: a catalogue image is fetched by its id behind the token, as JPEG bytes only (ADR 0011)', () => {
  const op = doc.paths['/catalogue_images/{image_id}'].get;
  assert.deepEqual(Object.keys(doc.paths['/catalogue_images/{image_id}']), ['get']);
  assert.equal(op.security, undefined, 'inherits the bearer token');
  assert.deepEqual(op.parameters, [{ $ref: '#/components/parameters/ImageIdPath' }]);
  assert.deepEqual(doc.components.parameters.ImageIdPath.schema, { $ref: '#/components/schemas/Id' });
  assert.deepEqual(Object.keys(op.responses).sort(), ['200', '400', '401', '404', '429']);
  assert.deepEqual(op.responses['200'].content, { 'image/jpeg': { schema: { type: 'string', contentMediaType: 'image/jpeg' } } });
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
const validBean = () => ({
  bean_id: ID,
  vocabulary_version: 1,
  verified: false,
  barcode: '4006381333931',
  open_food_facts_match: true,
  open_food_facts: {
    name: 'Ethiopia Guji <b>washed</b>',
    brand: 'Rösterei Beispiel',
    image_id: '01JD8Z5Y3V9Q6M2K4N7P8R0S2V',
  },
  picked_attributes: { process: 'washed' },
  operator_attributes: {},
});
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
  assert.deepEqual(validate('HealthStatus', { status: 'ok' }), []);
  assert.deepEqual(validate('Bean', validBean()), []);
  assert.deepEqual(validate('Bean', { ...validBean(), open_food_facts: { name: 'ü'.repeat(150), brand: 'x' } }), [], 'length counts code points');
  assert.deepEqual(validate('OpenFoodFactsProduct', {}), [], 'every field is optional');
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
  rejects('BrewInput', brewWith((b) => { b.vocabulary_version = 3; }), 'unpublished vocabulary version');
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
  const offWith = (fields) => ({ ...validBean(), open_food_facts: { ...validBean().open_food_facts, ...fields } });
  rejects('Bean', offWith({ name: 'x'.repeat(151) }), 'name longer than 150');
  rejects('Bean', offWith({ brand: 'x'.repeat(101) }), 'brand longer than 100');
  rejects('Bean', offWith({ name: '' }), 'empty name');
  rejects('Bean', offWith({ origin: 'Guji' }), 'no other Open Food Facts text');
  rejects('Bean', offWith({ image_id: 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg' }), 'an image URL is not an image id');
  rejects('Bean', offWith({ image_id: '01jd8z5y3v9q6m2k4n7p8r0s2v' }), 'image ids are upper-case ULIDs');
  rejects('Bean', offWith({ image_id: 'catalogue/01JD8Z5Y3V9Q6M2K4N7P8R0S2V.jpg' }), 'not a bucket key');
  rejects('Bean', offWith({ image_ref: 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg' }), 'the old Open Food Facts image URL is gone');
  rejects('BeanCreate', { vocabulary_version: 1, attributes: {}, open_food_facts: { name: 'Ethiopia Guji' } }, 'Open Food Facts text is never sent');
  rejects('HealthStatus', { status: 'degraded' }, 'only ok');
  rejects('HealthStatus', { status: 'ok', version: '1.2.3' }, 'nothing but status');
  rejects('HealthStatus', {}, 'status required');
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
    'GET /export 200: a text/csv body must be exactly { type: string, contentMediaType: text/csv }',
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
    s.VocabularyVersion.maximum = 3;
    delete s.Intensities.properties.bitterness;
    s.WaterG['x-vocabulary-rnage'] = 'brew.ranges.water_g';
  }), context);
  assertProblem(problems, '#/components/schemas/DoseDg: bounds 50..1000 differ from vocabulary brew.ranges.dose_g 5..100');
  assertProblem(problems, '#/components/schemas/WaterTempC: bounds 80..96 differ');
  assertProblem(problems, '#/components/schemas/Score: multipleOf 0.25 differs from vocabulary step 0.5');
  assertProblem(problems, '#/components/schemas/GrindNormalised: step 0.5 is fractional, so type must be number');
  assertProblem(problems, '#/components/schemas/BrewTimeS: step 1 is whole, so type must be integer');
  assertProblem(problems, 'maxItems 6 differs from vocabulary flavour_notes.max_picks 5');
  assertProblem(problems, '#/components/schemas/VocabularyVersion: vocabulary version must be an integer from 1 to the latest published version 2');
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

test('lint fails: wide or unbounded string patterns', () => {
  const cases = [
    ['^.*$', 'wide class .'],
    ['^.{1,10}$', 'wide class .'],
    ['^\\S{1,10}$', 'wide class \\S'],
    ['^\\w{1,10}$', 'wide class \\w'],
    ['^\\D{1,10}$', 'wide class \\D'],
    ['^[\\s]{1,10}$', 'wide class \\s'],
    ['^\\p{L}{1,10}$', 'wide class \\p'],
    ['^[^<>]{1,10}$', 'negated class'],
    ['^[a-z]*$', 'unbounded quantifier *'],
    ['^[a-z]+$', 'unbounded quantifier +'],
    ['^[a-z]{3,}$', 'unbounded quantifier {n,}'],
    ['^[a-z$', 'not a valid regular expression'],
  ];
  for (const [pattern, fragment] of cases) assertProblem(patternProblems(pattern), fragment);
  // Escaped or in-class characters are literal and fine.
  assert.deepEqual(patternProblems('^[.+*]{1,3}\\.[0-9]{2}$'), []);
  // The patterns in openapi.yaml pass.
  const s = schemas(doc);
  for (const name of ['Id', 'Barcode', 'Cursor']) assert.deepEqual(patternProblems(s[name].pattern), [], name);
  // And lintSchemas reports them on the schema.
  const problems = lintSchemas(broken((d) => { schemas(d).Cursor.pattern = '^.*$'; }));
  assertProblem(problems, '#/components/schemas/Cursor: pattern ^.*$ uses the wide class .');
  assertProblem(problems, '#/components/schemas/Cursor: pattern ^.*$ has the unbounded quantifier *');
});

test('lint fails: any schema keyword outside the allowlist', () => {
  const problems = lintSchemas(broken((d) => {
    const s = schemas(d);
    s.Rating.properties.flavour_notes.prefixItems = [{ type: 'string' }];
    s.Rating.properties.flavour_notes.contains = { type: 'string' };
    s.BrewParameters.if = { required: ['method'] };
    s.BrewParameters.then = { properties: { free: { type: 'string' } } };
    s.BrewParameters.else = {};
    s.BeanCreate.dependentSchemas = { barcode: { properties: { name: { type: 'string' } } } };
    s.Profile.propertyNames = { pattern: '^.*$' };
    s.Consent.unevaluatedProperties = { type: 'string' };
    s.Scores.patternProperties = { '^x': { type: 'string' } };
    s.Barcode.const = '4006381333931';
    s.WaterG.exclusiveMaximum = 1501;
  }));
  for (const [where, keyword] of [
    ['Rating/properties/flavour_notes', 'prefixItems'],
    ['Rating/properties/flavour_notes', 'contains'],
    ['BrewParameters', 'if'],
    ['BrewParameters', 'then'],
    ['BrewParameters', 'else'],
    ['BeanCreate', 'dependentSchemas'],
    ['Profile', 'propertyNames'],
    ['Consent', 'unevaluatedProperties'],
    ['Scores', 'patternProperties'],
    ['Barcode', 'const'],
    ['WaterG', 'exclusiveMaximum'],
  ]) assertProblem(problems, `#/components/schemas/${where}: keyword ${keyword} is not allowed`);
});

test('identity check matches user, owner, sub and uid as whole tokens, after camelCase', () => {
  for (const name of ['user', 'userId', 'userID', 'user_id', 'UserId', 'ownerId', 'owner', 'cognito_sub', 'cognitoSub', 'sub', 'uid', 'apple-uid', 'userid', 'subject', 'account_id', 'users']) {
    assert.ok(isIdentityName(name), `${name} must be rejected`);
  }
  for (const name of ['subscription', 'subscription_status', 'substitute', 'fluid', 'guide', 'bean_id', 'shelf_entry_id', 'cursor', 'account', 'vocabulary_version', 'next_cursor', 'buy_again', 'water_temp_special']) {
    assert.ok(!isIdentityName(name), `${name} must be allowed`);
  }
  const problems = findIdentityFields(broken((d) => {
    schemas(d).BrewInput.properties.ownerId = { $ref: '#/components/schemas/Id' };
    schemas(d).Profile.properties.cognito_sub = { $ref: '#/components/schemas/Id' };
    d.components.parameters.CursorQuery.name = 'uid';
    schemas(d).Profile.properties.subscription = { type: 'boolean' };
  }));
  assertProblem(problems, '#/components/schemas/BrewInput: property ownerId');
  assertProblem(problems, '#/components/schemas/Profile: property cognito_sub');
  assertProblem(problems, 'components.parameters.CursorQuery: parameter uid');
  assert.ok(!hasProblem(problems, 'subscription'), 'subscription is not an identity field');
});

// ---- Exception 1: response-only Open Food Facts text (ADR 0005) ----

const freeText = (extra = {}) => ({ type: 'string', maxLength: 10, readOnly: true, 'x-free-text-from': 'open_food_facts', ...extra });

test('free-text exception fails: marked text reachable from any request, through $ref, items, parameters or any keyword', () => {
  const problems = findRequestFreeText(broken((d) => {
    const s = schemas(d);
    // The response-only group put into a request through $ref.
    s.BeanCreate.properties.open_food_facts = { $ref: '#/components/schemas/OpenFoodFactsProduct' };
    // Inline, nested in array items, in a schema shared by several requests.
    s.BrewParameters.properties.label = { type: 'array', maxItems: 2, items: freeText() };
    // A query parameter.
    d.components.parameters.CursorQuery.schema = freeText();
    // An unused request body component that reaches the bean response.
    d.components.requestBodies = { Unused: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Bean' } } } } };
    // Hidden under a keyword the lint does not walk.
    s.Consent['x-hidden'] = { $ref: '#/components/schemas/OpenFoodFactsProduct' };
  }));
  for (const fragment of [
    '#/components/schemas/OpenFoodFactsProduct/properties/name: free text from open_food_facts is reachable from the POST /beans request body',
    '#/components/schemas/OpenFoodFactsProduct/properties/brand: free text from open_food_facts is reachable from the POST /beans request body',
    '#/components/schemas/BrewParameters/properties/label/items: free text from open_food_facts is reachable from the POST /brews request body',
    '#/components/schemas/BrewParameters/properties/label/items: free text from open_food_facts is reachable from the PUT /recipes/{recipe_id} request body',
    '#/components/parameters/CursorQuery/schema: free text from open_food_facts is reachable from GET /shelf parameters',
    '#/components/parameters/CursorQuery/schema: free text from open_food_facts is reachable from components.parameters.CursorQuery',
    '#/components/schemas/OpenFoodFactsProduct/properties/name: free text from open_food_facts is reachable from components.requestBodies.Unused',
    '#/components/schemas/OpenFoodFactsProduct/properties/name: free text from open_food_facts is reachable from the PUT /profile request body',
  ]) assertProblem(problems, fragment);
  // The same document is also rejected by the CLI's full run.
  assert.ok(checkOpenApi(broken((d) => {
    schemas(d).BeanAttributes.properties.roaster = freeText();
  }), context).some((p) => p.includes('reachable from the POST /beans request body')));
});

test('free-text exception fails: a response string without the marker, and every malformed marker', () => {
  const problems = lintSchemas(broken((d) => {
    const f = schemas(d).OpenFoodFactsProduct.properties;
    f.unmarked = { type: 'string', maxLength: 10 };
    delete f.name.maxLength;
    f.brand.maxLength = FREE_TEXT_MAX_LENGTH + 1;
    f.brand['x-free-text-from'] = 'user';
    f.writable = { type: 'string', maxLength: 10, 'x-free-text-from': 'open_food_facts' };
    f.image_id = { type: 'string', pattern: '^[0-9]{3}$', readOnly: true, maxLength: 120, 'x-free-text-from': 'open_food_facts' };
    f.count = { type: 'integer', minimum: 0, maximum: 9, readOnly: true, 'x-free-text-from': 'open_food_facts' };
    f.short = freeText({ minLength: 11 });
    schemas(d).Bean.properties.verified.readOnly = true;
  }));
  const at = (name) => `#/components/schemas/OpenFoodFactsProduct/properties/${name}`;
  for (const fragment of [
    `${at('unmarked')}: string without enum, pattern or format`,
    `${at('name')}: free text needs a maxLength from 1 to ${FREE_TEXT_MAX_LENGTH}`,
    `${at('brand')}: free text needs a maxLength from 1 to ${FREE_TEXT_MAX_LENGTH}`,
    `${at('brand')}: x-free-text-from "user" is not one of open_food_facts`,
    `${at('writable')}: free text needs readOnly: true`,
    `${at('image_id')}: x-free-text-from is only for a string without enum, pattern, format or contentMediaType`,
    `${at('count')}: x-free-text-from is only allowed on a string`,
    `${at('short')}: free text minLength must be an integer from 0 to maxLength`,
    '#/components/schemas/Bean/properties/verified: readOnly is only used on response-only free text',
  ]) assertProblem(problems, fragment);
});

test('free-text exception passes: the same marked field in a response only', () => {
  const changed = broken((d) => {
    d.paths['/profile'].get.responses['200'].content['application/json'].schema = {
      type: 'object', additionalProperties: false, properties: { title: freeText() },
    };
  });
  assert.deepEqual(lintSchemas(changed), []);
  assert.deepEqual(findRequestFreeText(changed), []);
});

// ---- Exception 2: GET /health without the token (ADR 0007) ----

test('health exception fails: any other route or method without the bearer token', () => {
  const problems = checkStructure(broken((d) => {
    d.paths['/profile'].get.security = [];
    d.paths['/brews'].get.security = [{}];
    d.paths['/shelf'].get.security = [{ bearerAuth: [] }, {}];
    d.paths['/health'].post = { ...clone(d.paths['/health'].get), operationId: 'postHealth' };
    d.paths['/healthz'] = { get: { ...clone(d.paths['/health'].get), operationId: 'getHealthz' } };
  }));
  for (const fragment of [
    'GET /profile: overrides security',
    'GET /brews: overrides security',
    'GET /shelf: overrides security',
    'POST /health: overrides security',
    'POST /health: no 401 response',
    'GET /healthz: overrides security',
    'GET /healthz: no 401 response',
    "#/paths/~1healthz/get/responses/200/content/application~1json/schema: #/components/schemas/HealthStatus is the body of GET /health and may not be used anywhere else",
  ]) assertProblem(problems, fragment);
});

test('health exception fails: GET /health with the token, input, other responses or another body', () => {
  const problems = checkStructure(broken((d) => {
    const health = d.paths['/health'].get;
    health.security = [{ bearerAuth: [] }];
    health.parameters = [{ $ref: '#/components/parameters/CursorQuery' }];
    health.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } };
    health.responses['404'] = { description: 'x' };
    health.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Profile' };
    d.paths['/profile'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/HealthStatus' };
  }));
  for (const fragment of [
    'GET /health: must declare security: []',
    'GET /health: the unauthenticated route takes no parameters',
    'GET /health: the unauthenticated route takes no request body',
    'GET /health: the unauthenticated route returns 200 and 429 only',
    'GET /health: 200 must return application/json with $ref #/components/schemas/HealthStatus',
    '#/components/schemas/HealthStatus is the body of GET /health and may not be used anywhere else',
  ]) assertProblem(problems, fragment);
  assertProblem(checkStructure(broken((d) => { delete d.paths['/health'].get.security; })), 'GET /health: must declare security: []');
  assertProblem(checkStructure(broken((d) => { delete d.paths['/health']; })), 'GET /health: missing');
});

test('health exception fails: the status enum changes, loses its tag or is used elsewhere', () => {
  const problems = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    s.HealthStatus.properties.status.enum = ['ok', 'degraded'];
    s.Profile.properties.status = { type: 'string', enum: ['ok'], 'x-health-status': true };
  }), context);
  assertProblem(problems, '#/components/schemas/HealthStatus/properties/status: the health status enum must be exactly [ok]');
  assertProblem(problems, '#/components/schemas/Profile/properties/status: x-health-status is only allowed on #/components/schemas/HealthStatus/properties/status');
  const untagged = checkVocabularyBindings(broken((d) => { delete schemas(d).HealthStatus.properties.status['x-health-status']; }), context);
  assertProblem(untagged, '#/components/schemas/HealthStatus/properties/status: enum without x-vocabulary');
});

test('health exception fails: HealthStatus grows a property, loses required or additionalProperties, or /health gets another method', () => {
  const extra = checkStructure(broken((d) => {
    schemas(d).HealthStatus.properties.version = { type: 'string', enum: ['1'], 'x-vocabulary': 'methods' };
  }));
  assertProblem(extra, 'components.schemas.HealthStatus: must have exactly one property, status');
  const emptyRequired = checkStructure(broken((d) => { schemas(d).HealthStatus.required = []; }));
  assertProblem(emptyRequired, 'components.schemas.HealthStatus: required must be exactly [status]');
  const noRequired = checkStructure(broken((d) => { delete schemas(d).HealthStatus.required; }));
  assertProblem(noRequired, 'components.schemas.HealthStatus: must hold exactly type, additionalProperties, required and properties');
  const open = checkStructure(broken((d) => { delete schemas(d).HealthStatus.additionalProperties; }));
  assertProblem(open, 'components.schemas.HealthStatus: must be an object with additionalProperties: false');
  const loose = checkStructure(broken((d) => { schemas(d).HealthStatus.properties.status = { type: 'string', pattern: '^[a-z]{1,10}$' }; }));
  assertProblem(loose, 'components.schemas.HealthStatus.properties.status: must be exactly { type: string, enum: [ok], x-health-status: true }');
  // A POST /health with the bearer token and a 401 is a well-formed operation,
  // and still fails: /health has GET only.
  const post = checkStructure(broken((d) => {
    d.paths['/health'].post = {
      operationId: 'postHealth',
      responses: { 204: { description: 'x' }, 401: { $ref: '#/components/responses/Unauthorized' } },
    };
  }));
  assert.deepEqual(post, ['POST /health: /health has GET only (docs/decisions/0007-unauthenticated-health-route.md)']);
  assert.deepEqual(checkStructure(doc), []);
});

// ---- Raw response bodies: CSV export and catalogue images (ADR 0011) ----

test('raw body check fails: another media type, a JPEG body with more than its media type, a JPEG request', () => {
  const problems = checkStructure(broken((d) => {
    const image = d.paths['/catalogue_images/{image_id}'].get;
    image.responses['200'].content = { 'image/png': { schema: { type: 'string', contentMediaType: 'image/png' } } };
    d.paths['/export'].get.responses['200'].content['text/csv'].schema = { type: 'string', contentMediaType: 'text/csv', maxLength: 10 };
    d.paths['/profile'].get.responses['200'].content = { 'image/jpeg': { schema: { type: 'string', contentMediaType: 'image/png' } } };
    d.paths['/profile'].put.requestBody.content = { 'image/jpeg': { schema: { type: 'string', contentMediaType: 'image/jpeg' } } };
  }));
  for (const fragment of [
    'GET /catalogue_images/{image_id} 200: media type image/png is not allowed',
    'GET /export 200: a text/csv body must be exactly { type: string, contentMediaType: text/csv }',
    'GET /profile 200: a image/jpeg body must be exactly { type: string, contentMediaType: image/jpeg }',
    'PUT /profile: requestBody must be application/json only',
  ]) assertProblem(problems, fragment);
  // contentMediaType that is not the body's own media type is a plain string, which the lint refuses.
  const lint = lintSchemas(broken((d) => {
    d.paths['/profile'].get.responses['200'].content = { 'application/json': { schema: { type: 'string', contentMediaType: 'image/jpeg' } } };
  }));
  assertProblem(lint, '/content/application~1json/schema: string without enum, pattern or format');
});

test('raw body check fails: a JPEG or CSV body anywhere a client sends data (requestBodies, callbacks, webhooks)', () => {
  const op = () => ({ operationId: 'x', responses: { 204: { description: 'x' }, 401: { $ref: '#/components/responses/Unauthorized' } } });
  for (const mediaType of ['image/jpeg', 'text/csv']) {
    const raw = () => ({ required: true, content: { [mediaType]: { schema: { type: 'string', contentMediaType: mediaType } } } });
    const cases = [
      ['an unused components.requestBodies entry', (d) => { d.components.requestBodies = { Upload: raw() }; },
        '#/components/requestBodies/Upload/content/'],
      ['a callback requestBody', (d) => {
        d.paths['/brews'].post.callbacks = { done: { '{$request.body#/url}': { post: { ...op(), requestBody: raw() } } } };
      }, '#/paths/~1brews/post/callbacks/done/'],
      ['a webhook requestBody', (d) => { d.webhooks = { photo: { post: { ...op(), operationId: 'photoHook', requestBody: raw() } } }; },
        '#/webhooks/photo/post/requestBody/content/'],
      ['a components.responses body', (d) => {
        d.components.responses.Raw = { description: 'x', content: { [mediaType]: { schema: { type: 'string', contentMediaType: mediaType } } } };
      }, '#/components/responses/Raw/content/'],
    ];
    for (const [name, mutate, where] of cases) {
      const changed = broken(mutate);
      const problems = checkOpenApi(changed, context);
      assert.ok(
        problems.some((p) => p.startsWith(where) && p.endsWith(': string without enum, pattern or format')),
        `${mediaType} in ${name}:\n${problems.join('\n')}`,
      );
    }
  }
  // The real raw bodies, directly under an operation's response, still pass.
  assert.deepEqual(lintSchemas(doc), []);
});

// ---- Vocabulary v2: published on 2026-11-25 and bound (ADR 0004, 0006, 0011) ----

test('v2 is bound: origin, species and variety are in BeanAttributes, and the version allows 2', () => {
  const s = schemas(doc);
  assert.equal(s.VocabularyVersion.maximum, 2);
  assert.deepEqual(s.BeanAttributes.properties, {
    process: { $ref: '#/components/schemas/Process' },
    roast_level: { $ref: '#/components/schemas/RoastLevel' },
    origin: { $ref: '#/components/schemas/Origin' },
    species: { $ref: '#/components/schemas/Species' },
    variety: { $ref: '#/components/schemas/Variety' },
  });
  const lists = collectIds(loadVocabulary(2)).lists;
  assert.deepEqual([s.Origin['x-vocabulary'], s.Origin.enum], ['origins', lists.origins]);
  assert.deepEqual([s.Species['x-vocabulary'], s.Species.enum], ['species', lists.species]);
  assert.deepEqual([s.Variety['x-vocabulary'], s.Variety.enum], ['varieties', lists.varieties]);
  assert.deepEqual(context.draftLists, {});
});

test('v2 bean attributes: the schema accepts v2 ids and rejects anything else', () => {
  assert.deepEqual(validate('BeanCreate', { vocabulary_version: 2, attributes: { origin: 'costa_rica', species: 'arabica', variety: 'geisha', process: 'honey' } }), []);
  assert.deepEqual(validate('BeanCreate', { vocabulary_version: 2, attributes: { origin: 'hawaii', variety: 'java', species: 'arabica_robusta_blend' } }), []);
  const rejects = (value, why) => assert.notDeepEqual(validate('BeanCreate', value), [], why);
  rejects({ vocabulary_version: 2, attributes: { origin: 'Costa Rica' } }, 'origin is an id');
  rejects({ vocabulary_version: 2, attributes: { variety: 'robusta' } }, 'robusta is a species, not a variety');
  rejects({ vocabulary_version: 2, attributes: { species: 'canephora' } }, 'not a species id');
  rejects({ vocabulary_version: 2, attributes: { country: 'indonesia' } }, 'the country is derived from the vocabulary, never sent');
  rejects({ vocabulary_version: 3, attributes: {} }, 'v3 is not published');
  // The schema is the union over versions, so origin with version 1 passes
  // here; the server rejects it, because v1 has no origins (ADR 0004, M1-T5).
  assert.deepEqual(validate('BeanCreate', { vocabulary_version: 1, attributes: { origin: 'kenya' } }), []);
});

test('once a later version is published, the contract fails until it is bound and allowed', () => {
  // A made-up v3 that adds a list, published.
  const v3 = clone(loadVocabulary(2));
  for (const file of Object.values(v3)) { file.version = 3; file.status = 'published'; }
  v3.bean.altitudes = [{ id: 'low' }, { id: 'high' }];
  const versions = [1, 2].map((version) => ({ version, files: loadVocabulary(version) }));
  const published = buildVocabularyContext([...versions, { version: 3, files: v3 }], context.languages);
  assert.equal(published.latestPublished, 3);
  const problems = checkVocabularyBindings(doc, published);
  assertProblem(problems, 'vocabulary list altitudes is not used by any schema');
  assertProblem(problems, 'vocabulary version must be an integer from 1 to the latest published version 3');
  // While it is a draft, its new list cannot be bound.
  for (const file of Object.values(v3)) file.status = 'draft';
  const draft = buildVocabularyContext([...versions, { version: 3, files: v3 }], context.languages);
  assert.equal(draft.latestPublished, 2);
  assert.deepEqual(draft.draftLists, { altitudes: 3 });
  const bound = broken((d) => {
    schemas(d).Altitude = { type: 'string', enum: ['low', 'high'], 'x-vocabulary': 'altitudes' };
    schemas(d).BeanAttributes.properties.altitude = { $ref: '#/components/schemas/Altitude' };
  });
  assertProblem(checkVocabularyBindings(bound, draft), '#/components/schemas/Altitude: x-vocabulary altitudes is only in draft vocabulary v3; bind it when v3 is published');
});

test('v2 lists must stay bound and in step with the vocabulary', () => {
  const unbound = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    delete s.BeanAttributes.properties.origin;
    delete s.BeanAttributes.properties.species;
    delete s.BeanAttributes.properties.variety;
    delete s.Origin;
    delete s.Species;
    delete s.Variety;
  }), context);
  for (const name of ['origins', 'species', 'varieties']) assertProblem(unbound, `vocabulary list ${name} is not used by any schema`);
  const drifted = checkVocabularyBindings(broken((d) => {
    const s = schemas(d);
    s.Origin.enum = s.Origin.enum.filter((id) => id !== 'ethiopia');
    s.Variety.enum.push('robusta');
    s.Species.enum.reverse();
  }), context);
  assertProblem(drifted, '#/components/schemas/Origin: enum differs from vocabulary origins; missing ethiopia');
  assertProblem(drifted, '#/components/schemas/Variety: enum differs from vocabulary varieties; not in vocabulary robusta');
  assertProblem(drifted, '#/components/schemas/Species: enum differs from vocabulary species; order differs');
  const stale = checkVocabularyBindings(broken((d) => { schemas(d).VocabularyVersion.maximum = 1; }), context);
  assertProblem(stale, 'vocabulary version must be an integer from 1 to the latest published version 2');
});

test('every list of the latest published version is bound, except the documented ones', () => {
  const problems = checkVocabularyBindings(broken((d) => {
    delete schemas(d).Rating.properties.intensities;
    delete schemas(d).Intensities;
  }), context);
  assertProblem(problems, 'vocabulary list intensity_dimensions is not used by any schema');
  assert.ok(!hasProblem(checkVocabularyBindings(doc, context), 'flavour_categories'));
});

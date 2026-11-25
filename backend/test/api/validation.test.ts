// Request validation of the shelf, brew and recipe routes (M1-T5): ranges, half
// steps, the five-note maximum, unknown properties, the vocabulary version,
// method-dependent fields, and the body itself (type, size, encoding).
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/api/http.ts';
import { BrewSchema, RecipeSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { publishedVocabularies } from '../../src/generated/vocabulary.ts';
import { methodRulesFor, violatesMethodRules } from '../../src/vocabulary/method-rules.ts';
import type { MethodFieldRule } from '../../src/vocabulary/method-rules.ts';
import { brewBody, harness, recipeBody, shelfBody, withField } from './helpers.ts';
import type { Harness } from './helpers.ts';

let h: Harness;
let shelfId = '';

beforeEach(async () => {
  h = harness();
  const created = await h.call('POST', '/shelf', { json: shelfBody() });
  shelfId = ShelfEntrySchema.parse(created.body).shelf_entry_id;
});

async function brewStatus(body: Record<string, unknown>): Promise<number> {
  return (await h.call('POST', '/brews', { json: body })).status;
}

async function brewWith(path: string, value: unknown): Promise<number> {
  return brewStatus(withField(brewBody(shelfId), path, value));
}

describe('a valid body is accepted and returned as stored', () => {
  it('brew with a full rating', async () => {
    const response = await h.call('POST', '/brews', { json: brewBody(shelfId) });
    expect(response.status).toBe(201);
    expect(BrewSchema.parse(response.body).values).toEqual(brewBody(shelfId));
  });

  it('brew without a rating, and with only the method', async () => {
    expect(await brewWith('rating', undefined)).toBe(201);
    expect(await brewStatus({ ...withField(brewBody(shelfId), 'rating', undefined), parameters: { method: 'espresso' } })).toBe(201);
  });

  it('recipe', async () => {
    const response = await h.call('POST', '/recipes', { json: recipeBody() });
    expect(response.status).toBe(201);
    expect(RecipeSchema.parse(response.body).values).toEqual(recipeBody());
  });
});

describe('range limits (vocabulary v1, brew.ranges)', () => {
  it.each([
    ['parameters.dose_dg', [50, 51, 150, 999, 1000], [49, 1001, 0, -50, 150.5, 5, '150']],
    ['parameters.water_g', [10, 250, 1500], [9, 1501, 250.5]],
    ['parameters.water_temp_c', [80, 94, 100], [79, 101, 94.5]],
    ['parameters.brew_time_s', [1, 180, 172800], [0, 172801, 1.5]],
    ['parameters.grind_normalised', [1, 1.5, 4.5, 10], [0.5, 10.5, 4.25, 4.1]],
  ])('%s accepts %j and rejects %j', async (path, good, bad) => {
    for (const value of good) expect(await brewWith(path, value), `${path}=${String(value)}`).toBe(201);
    for (const value of bad) expect(await brewWith(path, value), `${path}=${String(value)}`).toBe(400);
  });

  it('the dose range comes from the vocabulary, scaled to decigrams (ADR 0004)', () => {
    expect(publishedVocabularies[1]?.ranges['brew.ranges.dose_g@10']).toEqual({ minimum: 50, maximum: 1000, multipleOf: 1 });
  });

  it('water temperature is a number or "cold", never both', async () => {
    const cold = withField(withField(brewBody(shelfId), 'parameters.water_temp_c', undefined), 'parameters.water_temp_special', 'cold');
    expect(await brewStatus(cold)).toBe(201);
    expect(await brewWith('parameters.water_temp_special', 'cold')).toBe(400);
    expect(await brewStatus(withField(cold, 'parameters.water_temp_special', 'hot'))).toBe(400);
  });

  it('recipes share the brew parameter ranges', async () => {
    expect((await h.call('POST', '/recipes', { json: recipeBody({ dose_dg: 1001 }) })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { json: recipeBody({ dose_dg: 49 }) })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { json: recipeBody({ dose_dg: 1000 }) })).status).toBe(201);
  });
});

describe('scores: eight criteria, 1 to 10 in half steps', () => {
  const criteria = ['aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall'];

  it.each(criteria)('%s accepts 1, 1.5, 7.5, 10 and rejects 0.5, 7.25, 10.5, 0, "8"', async (criterion) => {
    const path = `rating.scores.${criterion}`;
    for (const value of [1, 1.5, 7.5, 10]) expect(await brewWith(path, value), String(value)).toBe(201);
    for (const value of [0.5, 7.25, 10.5, 0, 7.1, '8', null]) expect(await brewWith(path, value), String(value)).toBe(400);
  });

  it('a rating scores all eight; a missing or an extra criterion is rejected', async () => {
    for (const criterion of criteria) expect(await brewWith(`rating.scores.${criterion}`, undefined)).toBe(400);
    expect(await brewWith('rating.scores.bitterness', 5)).toBe(400);
    expect(await brewWith('rating.scores', {})).toBe(400);
  });
});

describe('intensities, flavour notes, buy again', () => {
  it('intensities are low, medium or high, for acidity, body and bitterness only', async () => {
    for (const level of ['low', 'medium', 'high']) expect(await brewWith('rating.intensities.bitterness', level)).toBe(201);
    expect(await brewWith('rating.intensities.bitterness', 'extreme')).toBe(400);
    expect(await brewWith('rating.intensities.sweetness', 'low')).toBe(400);
    expect(await brewWith('rating.intensities', {})).toBe(201);
  });

  it('up to five flavour notes; six are rejected', async () => {
    const five = ['berry', 'jasmine', 'honey', 'cocoa', 'lemon'];
    expect(await brewWith('rating.flavour_notes', five)).toBe(201);
    expect(await brewWith('rating.flavour_notes', [...five, 'malt'])).toBe(400);
    expect(await brewWith('rating.flavour_notes', [])).toBe(201);
    expect(publishedVocabularies[1]?.values['flavour_notes.max_picks']).toBe(5);
  });

  it('flavour notes are unique ids from the vocabulary; a category is not a note', async () => {
    expect(await brewWith('rating.flavour_notes', ['berry', 'berry'])).toBe(400);
    expect(await brewWith('rating.flavour_notes', ['chocolate'])).toBe(400);
    expect(await brewWith('rating.flavour_notes', ['fruity'])).toBe(400);
    expect(await brewWith('rating.flavour_notes', ['Berry'])).toBe(400);
    expect(await brewWith('rating.flavour_notes', 'berry')).toBe(400);
  });

  it('buy again is a boolean', async () => {
    expect(await brewWith('rating.buy_again', false)).toBe(201);
    expect(await brewWith('rating.buy_again', 'yes')).toBe(400);
  });
});

describe('ids, dates and pick lists', () => {
  it('method is required and from the list', async () => {
    expect(await brewWith('parameters.method', undefined)).toBe(400);
    expect(await brewWith('parameters.method', 'pour_over')).toBe(400);
    expect(await brewWith('parameters.method', 'V60')).toBe(400);
  });

  it('water type and milk come from their lists', async () => {
    expect(await brewWith('parameters.water_type', 'spring')).toBe(400);
    expect(await brewWith('parameters.milk', 'goat')).toBe(400);
    expect(await brewWith('parameters.milk', 'oat')).toBe(201);
  });

  it('brewed_at is an RFC 3339 date-time on a real day', async () => {
    expect(await brewWith('brewed_at', '2026-11-25')).toBe(400);
    expect(await brewWith('brewed_at', '2026-02-30T07:00:00Z')).toBe(400);
    expect(await brewWith('brewed_at', '2026-11-25T07:00:00z')).toBe(400);
  });

  it('shelf: dates, bag size, price band and the bean id', async () => {
    for (const [field, value] of [
      ['purchase_date', '2026-02-30'],
      ['roast_date', '25.11.2026'],
      ['bag_size', 'g_750'],
      ['price_band', 'cheap'],
      ['bean_id', 'not-a-ulid'],
      ['bean_id', '01jdq8z6v3w4x5y6z7a8b9c0df'],
    ] as const) {
      expect((await h.call('POST', '/shelf', { json: shelfBody({ [field]: value }) })).status, field).toBe(400);
    }
    expect((await h.call('POST', '/shelf', { json: withField(shelfBody(), 'purchase_date', undefined) })).status).toBe(400);
  });
});

describe('unknown properties are rejected at every level', () => {
  it.each([
    ['note', 'a comment'],
    ['parameters.grinder', 'comandante'],
    ['parameters.dose_g', 15],
    ['rating.comment', 'nice'],
    ['rating.scores.overall_comment', 'x'],
    ['rating.intensities.saltiness', 'low'],
    ['sub', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'],
    ['user_id', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'],
    ['brew_id', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  ])('brew %s', async (path, value) => {
    expect(await brewWith(path, value)).toBe(400);
  });

  it('a __proto__ key is an unknown property, not a prototype', async () => {
    const text = JSON.stringify(brewBody(shelfId)).replace(/^\{/, '{"__proto__":{"admin":true},');
    expect((await h.call('POST', '/brews', { body: text })).status).toBe(400);
  });

  it('shelf and recipe too', async () => {
    expect((await h.call('POST', '/shelf', { json: shelfBody({ nickname: 'x' }) })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { json: { ...recipeBody(), name: 'x' } })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { json: recipeBody({ temperature: 90 }) })).status).toBe(400);
  });
});

describe('the vocabulary version', () => {
  it.each([[0], [3], [4], [-1], [1.5], ['1'], ['2'], [null]])('rejects vocabulary_version %j', async (version) => {
    expect(await brewWith('vocabulary_version', version)).toBe(400);
    expect((await h.call('POST', '/shelf', { json: shelfBody({ vocabulary_version: version }) })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { json: { ...recipeBody(), vocabulary_version: version } })).status).toBe(400);
  });

  it('is required', async () => {
    expect(await brewWith('vocabulary_version', undefined)).toBe(400);
  });

  it('accepts the published versions 1 and 2 on every route', async () => {
    for (const version of [1, 2]) {
      expect(await brewWith('vocabulary_version', version), `brew v${String(version)}`).toBe(201);
      expect((await h.call('POST', '/shelf', { json: shelfBody({ vocabulary_version: version }) })).status).toBe(201);
      expect((await h.call('POST', '/recipes', { json: { ...recipeBody(), vocabulary_version: version } })).status).toBe(201);
    }
  });

  it('loads exactly the published versions, v1 and v2', () => {
    expect(Object.keys(publishedVocabularies)).toEqual(['1', '2']);
  });
});

describe('method-dependent fields', () => {
  // The spec (F2) says fields depend on the method but defines no mapping, and
  // vocabulary v1 has none, so no published version has a rule.
  it('no published version defines a rule, so every method takes every field', async () => {
    for (const version of Object.keys(publishedVocabularies)) expect(methodRulesFor(Number(version))).toEqual([]);
    const methods = publishedVocabularies[1]?.lists.methods ?? [];
    expect(methods).toHaveLength(12);
    for (const method of methods) {
      expect(await brewWith('parameters.method', method), method).toBe(201);
      expect((await h.call('POST', '/recipes', { json: recipeBody({ method, milk: 'dairy', water_temp_c: 90 }) })).status).toBe(201);
    }
  });

  it('the hook rejects a field its method does not allow, and only that', () => {
    const rules: MethodFieldRule[] = [{ field: 'milk', allowedMethods: ['espresso', 'fully_automatic'] }];
    expect(violatesMethodRules({ method: 'v60', milk: 'oat' }, rules)).toBe(true);
    expect(violatesMethodRules({ method: 'espresso', milk: 'oat' }, rules)).toBe(false);
    expect(violatesMethodRules({ method: 'v60' }, rules)).toBe(false);
    expect(violatesMethodRules({ method: 'v60', milk: 'oat' }, [])).toBe(false);
  });
});

describe('the body', () => {
  it('needs the JSON content type', async () => {
    const body = JSON.stringify(recipeBody());
    expect((await h.call('POST', '/recipes', { body, headers: { 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { body, headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(201);
    expect((await h.call('POST', '/recipes', { body, headers: { 'content-type': 'application/json; charset=latin1' } })).status).toBe(400);
  });

  it('must be present on create and replace', async () => {
    expect((await h.call('POST', '/recipes', { headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { body: '' })).status).toBe(400);
  });

  it('must be a JSON object', async () => {
    for (const body of ['{', 'null', '[]', '"x"', '1', '{"vocabulary_version":1,"parameters":{"method":"v60"}} x']) {
      expect((await h.call('POST', '/recipes', { body })).status, body).toBe(400);
    }
  });

  it(`is limited to ${String(MAX_BODY_BYTES)} bytes`, async () => {
    const text = JSON.stringify(recipeBody());
    const atLimit = text + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(text));
    expect((await h.call('POST', '/recipes', { body: atLimit })).status).toBe(201);
    expect((await h.call('POST', '/recipes', { body: `${atLimit} ` })).status).toBe(400);
    // Base64: checked before and after decoding.
    expect((await h.call('POST', '/recipes', { body: Buffer.from(`${atLimit} `).toString('base64'), base64: true })).status).toBe(400);
  });

  it('may come base64-encoded, but must then be strict base64 of valid UTF-8', async () => {
    const text = JSON.stringify(recipeBody());
    expect((await h.call('POST', '/recipes', { body: Buffer.from(text).toString('base64'), base64: true })).status).toBe(201);
    expect((await h.call('POST', '/recipes', { body: `${Buffer.from(text).toString('base64')}!`, base64: true })).status).toBe(400);
    const invalidUtf8 = Buffer.concat([Buffer.from(text.slice(0, -2)), Buffer.from([0xff]), Buffer.from('}}')]);
    expect((await h.call('POST', '/recipes', { body: invalidUtf8.toString('base64'), base64: true })).status).toBe(400);
    expect((await h.call('POST', '/recipes', { body: text.replace('aeropress', 'aeropress\ud800') })).status).toBe(400);
  });

  it('is refused on get, list and delete', async () => {
    const body = '{}';
    expect((await h.call('GET', '/shelf', { body })).status).toBe(400);
    expect((await h.call('GET', `/shelf/${shelfId}`, { body })).status).toBe(400);
    expect((await h.call('DELETE', `/shelf/${shelfId}`, { body })).status).toBe(400);
    expect((await h.call('GET', `/shelf/${shelfId}`)).status).toBe(200);
  });

  it('a refused body never reaches the store', async () => {
    const before = h.store.calls.length;
    await brewWith('rating.scores.overall', 7.25);
    await h.call('PUT', `/shelf/${shelfId}`, { json: shelfBody({ bag_size: 'g_750' }) });
    expect(h.store.calls.slice(before)).toEqual([]);
  });
});

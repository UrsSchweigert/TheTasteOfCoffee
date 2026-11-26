// GET /export (M1-T6, ADR 0017; contracts/openapi.yaml, exportData): the CSV
// is parsed back and every column of every row is compared with the JSON
// resource the API returns for the same item. Also the exact format (UTF-8
// without BOM, every field quoted, CRLF after every row), the header from
// the contract, the row order, what is left out, and the size limit.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPORT_CONTENT_TYPE, ExportShapeError, ExportTooLargeError, MAX_EXPORT_BYTES, exportCsv, flatten } from '../../src/api/export.ts';
import { BrewSchema, RecipeSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import type { Brew } from '../../src/generated/contract.ts';
import { EXPORT_CSV_COLUMNS, EXPORT_CSV_ITEM_TYPES } from '../../src/generated/export.ts';
import { labelPhotoKey, lookupCounterKey, pendingLabelPhotoKey } from '../../src/repository/index.ts';
import { OPENAPI_FILE, parseOpenApi } from '../../scripts/codegen/paths.ts';
import { verifiedUserId } from '../events.ts';
import { FakeStore } from './fake-store.ts';
import { ALICE_SUB, BEAN, BOB_SUB, brewBody, harness, recipeBody, shelfBody } from './helpers.ts';
import type { Harness } from './helpers.ts';

const ALICE = verifiedUserId(ALICE_SUB);
const PHOTO_A = '01JDQ8Z6V3W4X5Y6Z7A8B9C0D1';
const PHOTO_B = '01JDQ8Z6V3W4X5Y6Z7A8B9C0D0';

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, Record<string, unknown>> }> }>>;
}
const contract = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')) as Contract;
const csvMedia = contract.paths['/export']?.get?.responses['200']?.content['text/csv'] ?? {};

/** A strict parser for this file's dialect: every field quoted, no quote inside, CRLF after every row. */
function parseCsv(text: string): string[][] {
  expect(text.endsWith('\r\n')).toBe(true);
  const lines = text.slice(0, -2).split('\r\n');
  return lines.map((line) => {
    expect(line).toMatch(/^"[^"\r\n]*"(?:,"[^"\r\n]*")*$/);
    return line.slice(1, -1).split('","');
  });
}

/**
 * The test's own oracle: where each column's value sits in the JSON resource
 * of each item type (the column table of the contract's exportData).
 */
const PARAMETERS = ['method', 'dose_dg', 'water_g', 'water_temp_c', 'water_temp_special', 'brew_time_s', 'grind_normalised', 'grinder', 'grind_setting', 'water_type', 'milk'];
const CRITERIA = ['aroma', 'flavour', 'aftertaste', 'acidity', 'body', 'sweetness', 'balance', 'overall'];
const ORACLE: Record<string, Record<string, string>> = {
  profile: { locale: 'locale', contribute_to_aggregates: 'consent.contribute_to_aggregates' },
  shelf_entry: {
    shelf_entry_id: 'shelf_entry_id',
    ...Object.fromEntries(['vocabulary_version', 'bean_id', 'purchase_date', 'roast_date', 'bag_size', 'price_band'].map((f) => [f, `values.${f}`])),
  },
  brew: {
    brew_id: 'brew_id',
    vocabulary_version: 'values.vocabulary_version',
    shelf_entry_id: 'values.shelf_entry_id',
    brewed_at: 'values.brewed_at',
    ...Object.fromEntries(PARAMETERS.map((f) => [f, `values.parameters.${f}`])),
    ...Object.fromEntries(CRITERIA.map((c) => [`scores_${c}`, `values.rating.scores.${c}`])),
    ...Object.fromEntries(['acidity', 'body', 'bitterness'].map((d) => [`intensities_${d}`, `values.rating.intensities.${d}`])),
    flavour_notes: 'values.rating.flavour_notes',
    buy_again: 'values.rating.buy_again',
  },
  recipe: {
    recipe_id: 'recipe_id',
    vocabulary_version: 'values.vocabulary_version',
    ...Object.fromEntries(PARAMETERS.map((f) => [f, `values.parameters.${f}`])),
  },
  label_photo: { photo_id: 'photo_id', bean_id: 'bean_id' },
};

function at(value: unknown, path: string): unknown {
  let node = value;
  for (const part of path.split('.')) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}

function text(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join(';');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('a column holds an object');
}

/** Every leaf path of a JSON value (arrays count as one leaf). */
function leaves(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([name, child]) => leaves(child, prefix === '' ? name : `${prefix}.${name}`));
}

async function populated(): Promise<{ h: Harness; json: Map<string, unknown> }> {
  const h = harness();
  const json = new Map<string, unknown>();
  // Two shelf entries, one with only the required fields.
  const shelfA = ShelfEntrySchema.parse((await h.call('POST', '/shelf', { json: shelfBody() })).body);
  const shelfB = ShelfEntrySchema.parse((await h.call('POST', '/shelf', { json: { vocabulary_version: 1, bean_id: BEAN, purchase_date: '2026-11-01' } })).body);
  // Brews logged with brewed_at moving forward, so the list order (newest brewed_at first) is the reverse of the id order.
  const full = brewBody(shelfA.shelf_entry_id);
  const cold = {
    vocabulary_version: 1,
    shelf_entry_id: shelfB.shelf_entry_id,
    brewed_at: '2026-11-26T06:00:00Z',
    parameters: { method: 'cold_brew', water_temp_special: 'cold' },
  };
  const rated = { ...full, brewed_at: '2026-11-27T06:00:00.5Z', rating: { scores: (full.rating as { scores: unknown }).scores } };
  // A v3 brew with a grinder and its own-scale setting (M2-T5).
  const ground = { ...full, vocabulary_version: 3, brewed_at: '2026-11-28T06:00:00Z', parameters: { method: 'v60', grinder: 'niche_zero', grind_setting: 24.5 } };
  const brews: Brew[] = [];
  for (const body of [full, cold, rated, ground]) {
    const created = await h.call('POST', '/brews', { json: body });
    expect(created.status, JSON.stringify(body)).toBe(201);
    brews.push(BrewSchema.parse(created.body));
  }
  const recipe = RecipeSchema.parse((await h.call('POST', '/recipes', { json: { vocabulary_version: 3, parameters: { method: 'espresso', grinder: 'df64', grind_setting: 40, grind_normalised: 9.5 } } })).body);
  const profile = (await h.call('PUT', '/profile', { json: { locale: 'de', consent: { contribute_to_aggregates: false } } })).body;
  // Label photos, completed out of id order; a pending upload and counters that must not appear.
  h.store.userPhotos.set(`${labelPhotoKey(ALICE, PHOTO_A).pk}|${labelPhotoKey(ALICE, PHOTO_A).sk}`, { beanId: BEAN, createdAt: 'x' });
  h.store.userPhotos.set(`${labelPhotoKey(ALICE, PHOTO_B).pk}|${labelPhotoKey(ALICE, PHOTO_B).sk}`, { beanId: BEAN, createdAt: 'x' });
  const pending = pendingLabelPhotoKey(ALICE, '01JDQ8Z6V3W4X5Y6Z7A8B9C0D9');
  h.store.pendingPhotos.set(`${pending.pk}|${pending.sk}`, { beanId: BEAN, expiresAt: 2_000_000_000 });
  const counter = lookupCounterKey(ALICE, '2026-11-25');
  h.store.lookupCounters.set(`${counter.pk}|${counter.sk}`, 3);
  // Bob's items never appear in Alice's file.
  await h.call('POST', '/recipes', { sub: BOB_SUB, json: recipeBody() });

  json.set(`profile`, profile);
  json.set(`shelf_entry ${shelfA.shelf_entry_id}`, (await h.call('GET', `/shelf/${shelfA.shelf_entry_id}`)).body);
  json.set(`shelf_entry ${shelfB.shelf_entry_id}`, (await h.call('GET', `/shelf/${shelfB.shelf_entry_id}`)).body);
  for (const brew of brews) json.set(`brew ${brew.brew_id}`, (await h.call('GET', `/brews/${brew.brew_id}`)).body);
  json.set(`recipe ${recipe.recipe_id}`, (await h.call('GET', `/recipes/${recipe.recipe_id}`)).body);
  json.set(`label_photo ${PHOTO_A}`, { photo_id: PHOTO_A, bean_id: BEAN });
  json.set(`label_photo ${PHOTO_B}`, { photo_id: PHOTO_B, bean_id: BEAN });
  return { h, json };
}

describe('the header', () => {
  it('is generated from the contract: x-csv-columns and x-csv-item-types, in order', () => {
    expect([...EXPORT_CSV_COLUMNS]).toEqual(csvMedia['x-csv-columns']);
    expect([...EXPORT_CSV_ITEM_TYPES]).toEqual(csvMedia['x-csv-item-types']);
    expect(Object.keys(ORACLE)).toEqual([...EXPORT_CSV_ITEM_TYPES]);
  });

  it('every column is filled by some item type, and every oracle column is a header column', () => {
    const filled = new Set(['item_type', ...Object.values(ORACLE).flatMap((columns) => Object.keys(columns))]);
    expect([...filled].sort()).toEqual([...EXPORT_CSV_COLUMNS].sort());
  });
});

describe('GET /export', () => {
  it('a caller with no items gets the header row only, in the exact format', async () => {
    const h = harness();
    const response = await h.call('GET', '/export');
    expect(response.status).toBe(200);
    expect(response.result.headers).toEqual({ 'content-type': EXPORT_CONTENT_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(EXPORT_CONTENT_TYPE).toBe('text/csv; charset=utf-8; header=present');
    expect(response.result.isBase64Encoded).toBe(false);
    expect(response.result.body).toBe(`${EXPORT_CSV_COLUMNS.map((c) => `"${c}"`).join(',')}\r\n`);
    // No Content-Disposition: the contract declares no response headers for it.
    expect(Object.keys(response.result.headers ?? {})).not.toContain('content-disposition');
  });

  it('writes grinder and grind_setting, right after grind_normalised, as the contract lists them', async () => {
    const columns = csvMedia['x-csv-columns'] as string[];
    const after = columns.indexOf('grind_normalised');
    expect(columns.slice(after, after + 3)).toEqual(['grind_normalised', 'grinder', 'grind_setting']);
    expect([...EXPORT_CSV_COLUMNS].slice(after, after + 3)).toEqual(['grind_normalised', 'grinder', 'grind_setting']);

    const { h } = await populated();
    const [header, ...rows] = parseCsv((await h.call('GET', '/export')).result.body ?? '');
    const at = (column: string): number => (header ?? []).indexOf(column);
    const grinders = rows.filter((row) => row[at('grinder')] !== '').map((row) => [row[at('item_type')], row[at('grinder')], row[at('grind_setting')]]);
    expect(grinders).toEqual([
      ['brew', 'niche_zero', '24.5'],
      ['recipe', 'df64', '40'],
    ]);
    // Every other brew and recipe has both columns empty.
    expect(rows.filter((row) => row[at('grinder')] === '' && row[at('grind_setting')] !== '')).toEqual([]);
  });

  it('parses back to the JSON resources, column by column, row by row', async () => {
    const { h, json } = await populated();
    const response = await h.call('GET', '/export');
    expect(response.status).toBe(200);
    const body = response.result.body ?? '';
    // UTF-8 without a byte order mark: the first byte is the opening quote.
    expect(Buffer.from(body, 'utf8')[0]).toBe(0x22);
    expect(body.charCodeAt(0)).not.toBe(0xfeff);
    const [header, ...rows] = parseCsv(body);
    expect(header).toEqual([...EXPORT_CSV_COLUMNS]);
    expect(rows).toHaveLength(json.size);

    const covered = new Set<string>();
    for (const row of rows) {
      expect(row).toHaveLength(EXPORT_CSV_COLUMNS.length);
      const fields = new Map(EXPORT_CSV_COLUMNS.map((column, index) => [column, row[index] ?? '']));
      const itemType = fields.get('item_type') ?? '';
      const oracle = ORACLE[itemType];
      if (oracle === undefined) throw new Error(`unknown item type ${itemType}`);
      const idColumn = itemType === 'profile' ? undefined : `${itemType === 'label_photo' ? 'photo' : itemType}_id`;
      const key = idColumn === undefined ? 'profile' : `${itemType} ${fields.get(idColumn as never) ?? ''}`;
      const resource = json.get(key);
      expect(resource, key).toBeDefined();
      covered.add(key);
      for (const column of EXPORT_CSV_COLUMNS) {
        if (column === 'item_type') continue;
        const path = oracle[column];
        expect(fields.get(column), `${key}: ${column}`).toBe(path === undefined ? '' : text(at(resource, path)));
      }
      // Nothing of the resource is lost: each leaf has a column.
      expect(leaves(resource).sort()).toEqual(
        Object.values(oracle)
          .filter((path) => at(resource, path) !== undefined)
          .sort(),
      );
    }
    expect([...covered].sort()).toEqual([...json.keys()].sort());
  });

  it('rows come by item type, in the contract order, each type by ascending id; counters and pending uploads are left out', async () => {
    const { h, json } = await populated();
    const rows = parseCsv((await h.call('GET', '/export')).result.body ?? '').slice(1);
    const types = rows.map((row) => row[0] ?? '');
    expect(types).toEqual(['profile', 'shelf_entry', 'shelf_entry', 'brew', 'brew', 'brew', 'brew', 'recipe', 'label_photo', 'label_photo']);
    const idIndex = (column: string): number => EXPORT_CSV_COLUMNS.indexOf(column as never);
    const brewIds = rows.filter((row) => row[0] === 'brew').map((row) => row[idIndex('brew_id')] ?? '');
    expect(brewIds).toEqual([...brewIds].sort());
    // The brews were logged newest brewed_at first, so the list route's order is not the id order.
    const listed = (h.store.listBrews(ALICE) as Promise<{ items: Brew[] }>).then((page) => page.items.map((brew) => brew.brew_id));
    expect(await listed).not.toEqual(brewIds);
    const photoIds = rows.filter((row) => row[0] === 'label_photo').map((row) => row[idIndex('photo_id')]);
    expect(photoIds).toEqual([PHOTO_B, PHOTO_A]);
    const body = (await h.call('GET', '/export')).result.body ?? '';
    expect(body).not.toContain('01JDQ8Z6V3W4X5Y6Z7A8B9C0D9');
    expect(body).not.toContain('LOOKUPS');
    expect(json.size).toBe(rows.length);
  });

  it('values are written as in JSON: booleans, shortest decimals, notes joined by ;', async () => {
    const { h } = await populated();
    const body = (await h.call('GET', '/export')).result.body ?? '';
    expect(body).toContain('"berry;jasmine;honey"');
    expect(body).toContain('"4.5"');
    expect(body).toContain('"9.5"');
    expect(body).toContain('"7.5"');
    expect(body).toContain('"true"');
    expect(body).toContain('"false"');
    expect(body).toContain('"2026-11-25T07:30:00.250+01:00"');
    expect(body).not.toMatch(/\de[+-]?\d/);
  });

  it('a query or a body is 400; no token is 401', async () => {
    const h = harness();
    expect((await h.call('GET', '/export', { query: 'format=json' })).status).toBe(400);
    expect((await h.call('GET', '/export', { json: {} })).status).toBe(400);
    expect((await h.call('GET', '/export', { sub: null })).status).toBe(401);
    expect(h.store.calls).toEqual([]);
  });

  it('over the size limit is 500 ExportTooLargeError with no body', async () => {
    const store = new FakeStore();
    const brew = BrewSchema.parse({ brew_id: PHOTO_A, values: { ...brewBody(PHOTO_A) } });
    const brews = Array.from({ length: 25_000 }, (_, index) => ({ ...brew, brew_id: `01JDQ8Z6V3W4X5Y6Z7A${String(index).padStart(7, '0')}` }));
    store.exportItems = () => Promise.resolve({ shelfEntries: [], brews, recipes: [], labelPhotos: [] });
    const h = harness({ store });
    const response = await h.call('GET', '/export');
    expect(response.status).toBe(500);
    expect(response.result.body).toBeUndefined();
    expect(h.logs).toEqual([{ operation: 'exportData', status: 500, request_id: 'request-1', error: 'ExportTooLargeError' }]);
  });

  it('the documented capacity holds: a full brew row is under 400 bytes, so over 13,000 brews fit', () => {
    const brew = BrewSchema.parse({ brew_id: PHOTO_A, values: brewBody(PHOTO_A) });
    const one = exportCsv({ shelfEntries: [], brews: [brew], recipes: [], labelPhotos: [] });
    const header = exportCsv({ shelfEntries: [], brews: [], recipes: [], labelPhotos: [] });
    const row = Buffer.byteLength(one) - Buffer.byteLength(header);
    expect(row).toBeLessThan(400);
    expect(Math.floor((MAX_EXPORT_BYTES - Buffer.byteLength(header)) / 400)).toBeGreaterThan(13_000);
    expect(MAX_EXPORT_BYTES).toBeLessThan(6_000_000);
    expect(() => exportCsv({ shelfEntries: [], brews: [brew, { ...brew, brew_id: PHOTO_B }], recipes: [], labelPhotos: [] }, Buffer.byteLength(one))).toThrow(
      ExportTooLargeError,
    );
  });
});

describe('flatten', () => {
  it('follows the contract rule: wrappers add nothing, other objects prefix their fields', () => {
    expect(Object.fromEntries(flatten({ consent: { contribute_to_aggregates: true }, locale: 'en' }))).toEqual({ contribute_to_aggregates: 'true', locale: 'en' });
    expect(Object.fromEntries(flatten({ values: { rating: { scores: { body: 6 }, intensities: { body: 'low' } } } }))).toEqual({
      scores_body: '6',
      intensities_body: 'low',
    });
  });

  it('refuses a field without a column, two fields on one column, and values CSV would have to escape', () => {
    expect(() => flatten({ note: 'x' })).toThrow(ExportShapeError);
    expect(() => flatten({ values: { bean_id: 'a' }, bean_id: 'b' })).toThrow(ExportShapeError);
    for (const bad of ['a"b', 'a,b', 'a\r\nb', 'a\nb']) expect(() => flatten({ bean_id: bad })).toThrow(ExportShapeError);
    expect(() => flatten({ flavour_notes: ['a;b'] })).toThrow(ExportShapeError);
    expect(() => flatten({ flavour_notes: [1] })).toThrow(ExportShapeError);
    expect(() => flatten({ dose_dg: 1e21 })).toThrow(ExportShapeError);
    expect(() => flatten({ dose_dg: 1e-7 })).toThrow(ExportShapeError);
    expect(() => flatten({ dose_dg: null })).toThrow(ExportShapeError);
  });
});

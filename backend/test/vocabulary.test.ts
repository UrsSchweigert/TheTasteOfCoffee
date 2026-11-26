// The generated vocabulary (src/generated/vocabulary.ts) and the check of a
// request against the version it names (ADR 0004).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERATED_VOCABULARY_FILE,
  OPENAPI_FILE,
  VOCABULARY_DIR,
  generateVocabularyFromContract,
  parseOpenApi,
} from '../scripts/codegen/paths.ts';
import { VocabularyGenerationError, generateVocabularySource, readVocabularyDir } from '../scripts/codegen/vocabulary.ts';
import { BeanCreateSchema, BrewInputSchema } from '../src/generated/contract.ts';
import { publishedVocabularies, vocabularyBindings } from '../src/generated/vocabulary.ts';
import { conformsToVocabulary, publishedVocabulary } from '../src/vocabulary/check.ts';
import type { PublishedVocabulary } from '../src/vocabulary/types.ts';
import { validBrewInput } from './fixtures.ts';

const contract = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8'));
const vocabularyFile = (version: number, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(VOCABULARY_DIR, `v${String(version)}`, `${name}.json`), 'utf8')) as Record<string, unknown>;
const v1 = (name: string): Record<string, unknown> => vocabularyFile(1, name);
const v2 = (name: string): Record<string, unknown> => vocabularyFile(2, name);
const ids = (list: unknown): string[] => (list as { id: string }[]).map((item) => item.id);

describe('src/generated/vocabulary.ts', () => {
  it('is what the generator makes from contracts/ (no drift)', () => {
    const committed = readFileSync(GENERATED_VOCABULARY_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === generateVocabularyFromContract(), 'run `npm run generate` and commit the result').toBe(true);
  });

  it('holds v1, v2 and v3, the published versions', () => {
    expect(Object.keys(publishedVocabularies)).toEqual(['1', '2', '3']);
    const lists = publishedVocabularies[1]?.lists ?? {};
    expect(lists.methods).toEqual(ids(v1('brew').methods));
    expect(lists.milk_types).toEqual(ids(v1('brew').milk_types));
    expect(lists.criteria).toEqual(ids(v1('criteria').criteria));
    expect(lists.price_bands).toEqual(ids(v1('shelf').price_bands));
    const notes = (v1('flavour_notes').flavour_categories as { flavour_notes: unknown }[]).flatMap((c) => ids(c.flavour_notes));
    expect(lists.flavour_notes).toEqual(notes);
    // Only what the API binds: the categories group notes for display and are not bound.
    expect(lists).not.toHaveProperty('flavour_categories');
    expect(lists).not.toHaveProperty('origins');
  });

  it('holds the v2 bean lists, ids only: a region\'s country is vocabulary data, not a request field', () => {
    const lists = publishedVocabularies[2]?.lists ?? {};
    expect(lists.origins).toEqual(ids(v2('bean').origins));
    expect(lists.species).toEqual(ids(v2('bean').species));
    expect(lists.varieties).toEqual(ids(v2('bean').varieties));
    expect(lists.varieties).not.toContain('robusta');
    // `java` is an origin and a variety; the lists are kept apart by namespace.
    expect(lists.origins).toContain('java');
    expect(lists.varieties).toContain('java');
    expect(JSON.stringify(publishedVocabularies)).not.toContain('country');
    // v1 and v2 share every other list.
    for (const namespace of Object.keys(publishedVocabularies[1]?.lists ?? {})) {
      expect(lists[namespace], namespace).toEqual(publishedVocabularies[1]?.lists[namespace]);
    }
  });

  it('binds every vocabulary field of the request bodies', () => {
    expect(vocabularyBindings.Method).toEqual({ list: 'methods' });
    expect(vocabularyBindings.Score).toEqual({ range: 'criteria.scale@1' });
    expect(vocabularyBindings.DoseDg).toEqual({ range: 'brew.ranges.dose_g@10' });
    expect(vocabularyBindings.Scores?.keys).toBe('criteria');
    expect(vocabularyBindings.Rating?.properties?.flavour_notes).toEqual({ items: { ref: 'FlavourNote' }, maxItems: 'flavour_notes.max_picks' });
    expect(vocabularyBindings.VocabularyVersion).toEqual({ version: true });
    expect(vocabularyBindings.Origin).toEqual({ list: 'origins' });
    expect(vocabularyBindings.Species).toEqual({ list: 'species' });
    expect(vocabularyBindings.Variety).toEqual({ list: 'varieties' });
    expect(vocabularyBindings.BeanAttributes?.properties).toEqual({
      process: { ref: 'Process' },
      roast_level: { ref: 'RoastLevel' },
      origin: { ref: 'Origin' },
      species: { ref: 'Species' },
      variety: { ref: 'Variety' },
    });
  });
});

describe('conformsToVocabulary', () => {
  const brew = BrewInputSchema.parse(validBrewInput());

  it('accepts a valid v1 brew', () => {
    expect(conformsToVocabulary('BrewInput', brew, 1)).toBe(true);
  });

  it('accepts the same brew under v2, which keeps every v1 list', () => {
    expect(publishedVocabulary(2)).toBeDefined();
    expect(conformsToVocabulary('BrewInput', { ...brew, vocabulary_version: 2 }, 2)).toBe(true);
  });

  it('rejects an unpublished or unknown version', () => {
    expect(publishedVocabulary(3)).toBeDefined();
    expect(publishedVocabulary(4)).toBeUndefined();
    expect(publishedVocabulary(0)).toBeUndefined();
    expect(publishedVocabulary(1.5)).toBeUndefined();
    expect(conformsToVocabulary('BrewInput', { ...brew, vocabulary_version: 4 }, 4)).toBe(false);
    expect(conformsToVocabulary('NoSuchSchema', brew, 1)).toBe(false);
  });

  it('accepts origin, species and variety with version 2 and rejects them with version 1 (v1 has no such lists)', () => {
    const create = (version: number, attributes: Record<string, string>): unknown =>
      BeanCreateSchema.parse({ vocabulary_version: version, barcode: '4006381333931', attributes });
    const v2Attributes = { origin: 'hawaii', species: 'arabica', variety: 'java', process: 'washed', roast_level: 'light' };
    expect(conformsToVocabulary('BeanCreate', create(2, v2Attributes), 2)).toBe(true);
    expect(conformsToVocabulary('BeanCreate', create(2, { origin: 'java', variety: 'red_bourbon' }), 2)).toBe(true);
    for (const attribute of ['origin', 'species', 'variety'] as const) {
      const one = { [attribute]: v2Attributes[attribute] };
      expect(conformsToVocabulary('BeanCreate', create(2, one), 2), attribute).toBe(true);
      expect(conformsToVocabulary('BeanCreate', create(1, one), 1), attribute).toBe(false);
    }
    // v1 attributes alone stay valid under both versions.
    expect(conformsToVocabulary('BeanCreate', create(1, { process: 'washed' }), 1)).toBe(true);
    expect(conformsToVocabulary('BeanCreate', create(2, { process: 'washed' }), 2)).toBe(true);
    // The version inside the value must match the version checked against.
    expect(conformsToVocabulary('BeanCreate', create(1, { process: 'washed' }), 2)).toBe(false);
    // A value that passed the union schema but is in no list of the version, as a backstop.
    expect(conformsToVocabulary('BeanCreate', { vocabulary_version: 2, attributes: { variety: 'robusta' } }, 2)).toBe(false);
  });

  it('checks against the version named, not the union of versions', () => {
    // A made-up later version that dropped `cezve`, narrowed the dose, allows three notes and two criteria.
    const v1Data = publishedVocabularies[1];
    if (v1Data === undefined) throw new Error('v1 is published');
    const later: PublishedVocabulary = {
      lists: { ...v1Data.lists, methods: (v1Data.lists.methods ?? []).filter((m) => m !== 'cezve') },
      ranges: { ...v1Data.ranges, 'brew.ranges.dose_g@10': { minimum: 60, maximum: 900, multipleOf: 1 } },
      values: { ...v1Data.values, 'flavour_notes.max_picks': 3 },
    };
    const check = (value: unknown): boolean => conformsToVocabulary('BrewInput', value, 9, vocabularyBindings, later);
    const at9 = { ...brew, vocabulary_version: 9 };
    expect(check(at9)).toBe(true);
    expect(check({ ...at9, parameters: { ...at9.parameters, method: 'cezve' } })).toBe(false);
    expect(check({ ...at9, parameters: { ...at9.parameters, dose_dg: 50 } })).toBe(false);
    expect(check({ ...at9, rating: { ...at9.rating, flavour_notes: ['berry', 'lemon', 'honey', 'cocoa'] } })).toBe(false);
    // The version inside the value must be the one checked against.
    expect(check(brew)).toBe(false);
    const fewerCriteria = { ...later, lists: { ...later.lists, criteria: ['aroma', 'overall'] } };
    expect(conformsToVocabulary('BrewInput', at9, 9, vocabularyBindings, fewerCriteria)).toBe(false);
    // A list the version does not have rejects every value bound to it.
    const noMilk = { ...later, lists: Object.fromEntries(Object.entries(later.lists).filter(([k]) => k !== 'milk_types')) };
    expect(conformsToVocabulary('BrewInput', at9, 9, vocabularyBindings, noMilk)).toBe(false);
  });

  it('rejects a value the schema should have refused, as a backstop', () => {
    expect(conformsToVocabulary('BrewInput', { ...brew, extra: 1 }, 1)).toBe(false);
    expect(conformsToVocabulary('BrewInput', { ...brew, parameters: { ...brew.parameters, dose_dg: 150.5 } }, 1)).toBe(false);
    expect(conformsToVocabulary('BrewInput', { ...brew, parameters: { ...brew.parameters, method: 'pour_over' } }, 1)).toBe(false);
    expect(conformsToVocabulary('BrewInput', { ...brew, parameters: 'v60' }, 1)).toBe(false);
  });
});

describe('the vocabulary generator', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function copy(): string {
    dir = mkdtempSync(join(tmpdir(), 'cupmark-vocabulary-'));
    cpSync(VOCABULARY_DIR, dir, { recursive: true });
    return dir;
  }

  it('refuses a published version whose files differ from its lock', () => {
    const root = copy();
    const file = join(root, 'v1', 'brew.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"cezve"', '"cezve_x"'));
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(/does not match v1.lock.json/);
  });

  it('refuses a published version without a lock', () => {
    const root = copy();
    rmSync(join(root, 'v1.lock.json'));
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(VocabularyGenerationError);
  });

  it('refuses an extra file in a published version', () => {
    const root = copy();
    writeFileSync(join(root, 'v1', 'extra.json'), '{"version":1,"status":"published"}');
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(/extra.json/);
  });

  it('leaves out a draft version, and refuses one that is half published', () => {
    // A draft v4, copied from v3 as contracts/README.md "Publishing a version" says.
    const root = copy();
    cpSync(join(root, 'v3'), join(root, 'v4'), { recursive: true });
    for (const name of ['bean', 'brew', 'criteria', 'flavour_notes', 'shelf']) {
      const file = join(root, 'v4', `${name}.json`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('"version": 3', '"version": 4').replace('"status": "published"', '"status": "draft"'));
    }
    const source = generateVocabularySource(contract, readVocabularyDir(root));
    expect(source).toContain('"3"');
    expect(source).not.toContain('"4"');
    expect(source).toBe(generateVocabularyFromContract());
    const file = join(root, 'v4', 'bean.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"status": "draft"', '"status": "published"'));
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(/some files are published/);
  });

  it('refuses v2 once a published file is edited, for example a region\'s country', () => {
    const root = copy();
    const file = join(root, 'v2', 'bean.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"country": "usa"', '"country": "mexico"'));
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(/v2\/bean.json: does not match v2.lock.json/);
  });

  it('CRLF line endings do not change the lock check', () => {
    const root = copy();
    const file = join(root, 'v1', 'brew.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    expect(generateVocabularySource(contract, readVocabularyDir(root))).toBe(generateVocabularyFromContract());
  });

  it('refuses unknown tags and steps that are not exact once scaled', () => {
    const doc = (schemas: Record<string, unknown>): unknown => ({ components: { schemas } });
    const versions = readVocabularyDir(VOCABULARY_DIR);
    expect(() => generateVocabularySource(doc({ A: { type: 'string', enum: ['a'], 'x-vocabulary-typo': 'x' } }), versions)).toThrow(/unknown tag/);
    expect(() =>
      generateVocabularySource(doc({ A: { type: 'number', minimum: 5, maximum: 100, 'x-vocabulary-range': 'brew.ranges.dose_g' } }), versions),
    ).toThrow(/not exact in binary/);
    expect(() => generateVocabularySource(doc({ A: { type: 'integer', 'x-vocabulary-scale': 10 } }), versions)).toThrow(/without/);
    expect(() => generateVocabularySource(doc({ A: { oneOf: [] } }), versions)).toThrow(/oneOf/);
  });
});

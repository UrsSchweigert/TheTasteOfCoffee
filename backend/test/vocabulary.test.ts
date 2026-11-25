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
import { BrewInputSchema } from '../src/generated/contract.ts';
import { publishedVocabularies, vocabularyBindings } from '../src/generated/vocabulary.ts';
import { conformsToVocabulary, publishedVocabulary } from '../src/vocabulary/check.ts';
import type { PublishedVocabulary } from '../src/vocabulary/types.ts';
import { validBrewInput } from './fixtures.ts';

const contract = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8'));
const v1 = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(VOCABULARY_DIR, 'v1', `${name}.json`), 'utf8')) as Record<string, unknown>;
const ids = (list: unknown): string[] => (list as { id: string }[]).map((item) => item.id);

describe('src/generated/vocabulary.ts', () => {
  it('is what the generator makes from contracts/ (no drift)', () => {
    const committed = readFileSync(GENERATED_VOCABULARY_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === generateVocabularyFromContract(), 'run `npm run generate` and commit the result').toBe(true);
  });

  it('holds v1 as published, and not the draft v2', () => {
    expect(Object.keys(publishedVocabularies)).toEqual(['1']);
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

  it('binds every vocabulary field of the request bodies', () => {
    expect(vocabularyBindings.Method).toEqual({ list: 'methods' });
    expect(vocabularyBindings.Score).toEqual({ range: 'criteria.scale@1' });
    expect(vocabularyBindings.DoseDg).toEqual({ range: 'brew.ranges.dose_g@10' });
    expect(vocabularyBindings.Scores?.keys).toBe('criteria');
    expect(vocabularyBindings.Rating?.properties?.flavour_notes).toEqual({ items: { ref: 'FlavourNote' }, maxItems: 'flavour_notes.max_picks' });
    expect(vocabularyBindings.VocabularyVersion).toEqual({ version: true });
  });
});

describe('conformsToVocabulary', () => {
  const brew = BrewInputSchema.parse(validBrewInput());

  it('accepts a valid v1 brew', () => {
    expect(conformsToVocabulary('BrewInput', brew, 1)).toBe(true);
  });

  it('rejects an unpublished or unknown version', () => {
    expect(publishedVocabulary(2)).toBeUndefined();
    expect(publishedVocabulary(0)).toBeUndefined();
    expect(publishedVocabulary(1.5)).toBeUndefined();
    expect(conformsToVocabulary('BrewInput', { ...brew, vocabulary_version: 2 }, 2)).toBe(false);
    expect(conformsToVocabulary('NoSuchSchema', brew, 1)).toBe(false);
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
    const root = copy();
    expect(generateVocabularySource(contract, readVocabularyDir(root))).not.toContain('"2"');
    const file = join(root, 'v2', 'bean.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"status": "draft"', '"status": "published"'));
    expect(() => generateVocabularySource(contract, readVocabularyDir(root))).toThrow(/some files are published/);
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VocabularyGenerationError, type VersionFiles } from '../../scripts/codegen/vocabulary.ts';
import { generateVocabularyFactsSource } from '../../scripts/codegen/vocabulary-facts.ts';
import { GENERATED_VOCABULARY_FACTS_FILE, VOCABULARY_DIR, generateVocabularyFactsFromContract } from '../../scripts/codegen/paths.ts';
import { BAG_SIZE_GRAMS, ORIGIN_COUNTRY } from '../../src/generated/vocabulary-facts.ts';

function file(version: number, name: string): { bag_sizes?: { id: string; grams: number }[]; origins?: { id: string; country?: string }[] } {
  return JSON.parse(readFileSync(join(VOCABULARY_DIR, `v${String(version)}`, `${name}.json`), 'utf8')) as never;
}

describe('src/generated/vocabulary-facts.ts (M3-T5)', () => {
  it('is what the generator makes from the published vocabulary', () => {
    const committed = readFileSync(GENERATED_VOCABULARY_FACTS_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === generateVocabularyFactsFromContract(), 'run `npm run generate` and commit the result').toBe(true);
  });

  it.each([1, 2, 3])('has the grams of every bag size of v%i, as in shelf.json', (version) => {
    const expected = Object.fromEntries((file(version, 'shelf').bag_sizes ?? []).map((b) => [b.id, b.grams]));
    expect(BAG_SIZE_GRAMS[version]).toEqual(expected);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
  });

  it('gives undefined for an unknown id or version, so rule 6 does not judge', () => {
    expect(BAG_SIZE_GRAMS[3]?.g_999).toBeUndefined();
    expect(BAG_SIZE_GRAMS[99]?.g_250).toBeUndefined();
  });

  it('rolls a region up to its country, a country to itself, and leaves blend, other and unknown out', () => {
    expect(ORIGIN_COUNTRY[3]?.sumatra).toBe('indonesia');
    expect(ORIGIN_COUNTRY[3]?.indonesia).toBe('indonesia');
    expect(ORIGIN_COUNTRY[3]?.ethiopia).toBe('ethiopia');
    for (const id of ['blend', 'other', 'unknown']) expect(ORIGIN_COUNTRY[3]?.[id]).toBeUndefined();
    const listed = file(3, 'bean').origins ?? [];
    for (const { id, country } of listed) {
      if (['blend', 'other', 'unknown'].includes(id)) continue;
      expect(ORIGIN_COUNTRY[3]?.[id]).toBe(country ?? id);
    }
  });

  it('v1 has no origin list, so no origin maps to a country there', () => {
    expect(ORIGIN_COUNTRY[1]).toEqual({});
  });
});

describe('vocabulary facts generator', () => {
  const published = (shelf: unknown, bean: unknown): VersionFiles => {
    const versionFiles = { shelf, bean };
    return { version: 7, files: versionFiles, hashes: {}, lock: undefined };
  };

  it('fails on a published version without a lock (it never reads a draft or unlocked version silently)', () => {
    expect(() => generateVocabularyFactsSource([published({ status: 'published', bag_sizes: [{ id: 'g_1', grams: 1 }] }, { status: 'published' })])).toThrow(VocabularyGenerationError);
  });

  it('leaves a draft version out', () => {
    const source = generateVocabularyFactsSource([published({ status: 'draft', bag_sizes: [{ id: 'g_1', grams: 1 }] }, { status: 'draft' })]);
    expect(source).not.toContain('g_1');
  });
});

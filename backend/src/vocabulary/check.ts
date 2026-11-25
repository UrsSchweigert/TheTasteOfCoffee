// Checks a request value against the vocabulary version it names (ADR 0004).
//
// The generated zod schemas accept the union of ids and the widest ranges over
// all published versions. This check narrows that to the one version the
// request sends in `vocabulary_version`: every id must exist in that version's
// list, every number must sit in that version's range and on its step, and
// every array must respect that version's maximum. The bindings and the
// version data are generated from contracts/ (src/generated/vocabulary.ts);
// nothing here names a list, a range or a field.
//
// Call it only on a value the generated schema has already accepted.
import { publishedVocabularies, vocabularyBindings } from '../generated/vocabulary.ts';
import type { PublishedVocabulary, VocabularyBinding } from './types.ts';

/** The published vocabulary of `version`, or undefined for a draft or unknown version. */
export function publishedVocabulary(version: number): PublishedVocabulary | undefined {
  return Number.isInteger(version) && Object.hasOwn(publishedVocabularies, version) ? publishedVocabularies[version] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Context {
  readonly version: number;
  readonly vocabulary: PublishedVocabulary;
  readonly bindings: Readonly<Record<string, VocabularyBinding>>;
}

function conforms(binding: VocabularyBinding | undefined, value: unknown, context: Context, depth: number): boolean {
  const { vocabulary, bindings } = context;
  // The contract has no reference cycles (the generator refuses them); this bounds a broken binding table.
  if (binding === undefined || depth > 32) return false;
  if (binding.ref !== undefined) {
    if (!Object.hasOwn(bindings, binding.ref)) return false;
    return conforms(bindings[binding.ref], value, context, depth + 1);
  }
  if (binding.list !== undefined) {
    const ids = Object.hasOwn(vocabulary.lists, binding.list) ? vocabulary.lists[binding.list] : undefined;
    return typeof value === 'string' && ids?.includes(value) === true;
  }
  if (binding.range !== undefined) {
    const range = Object.hasOwn(vocabulary.ranges, binding.range) ? vocabulary.ranges[binding.range] : undefined;
    return (
      typeof value === 'number' &&
      range !== undefined &&
      value >= range.minimum &&
      value <= range.maximum &&
      // Exact: every step is a multiple of 2^-20 (generator) and the value a double.
      value % range.multipleOf === 0
    );
  }
  if (binding.version === true) {
    // Every vocabulary_version in the value names the version being checked against.
    return value === context.version;
  }
  if (binding.properties !== undefined) {
    if (!isRecord(value)) return false;
    if (binding.keys !== undefined) {
      const ids = Object.hasOwn(vocabulary.lists, binding.keys) ? vocabulary.lists[binding.keys] : undefined;
      if (ids === undefined || !Object.keys(value).every((key) => ids.includes(key))) return false;
    }
    for (const [name, child] of Object.entries(value)) {
      // The schema has rejected unknown properties already; an unbound one here is a fault.
      if (!Object.hasOwn(binding.properties, name)) return false;
      if (child !== undefined && !conforms(binding.properties[name], child, context, depth + 1)) return false;
    }
    return true;
  }
  if (binding.items !== undefined) {
    if (!Array.isArray(value)) return false;
    if (binding.maxItems !== undefined) {
      const max = Object.hasOwn(vocabulary.values, binding.maxItems) ? vocabulary.values[binding.maxItems] : undefined;
      if (max === undefined || value.length > max) return false;
    }
    const items = binding.items;
    return value.every((item) => conforms(items, item, context, depth + 1));
  }
  // `{}`: dates, ids, booleans and the like carry nothing from the vocabulary.
  return true;
}

/**
 * True if `value`, already accepted by the generated schema `schemaName`,
 * uses only ids, ranges and limits of the published vocabulary `version`.
 * False for a draft or unknown version. `bindings` and `vocabulary` are
 * parameters for tests only; production uses the generated ones.
 */
export function conformsToVocabulary(
  schemaName: string,
  value: unknown,
  version: number,
  bindings: Readonly<Record<string, VocabularyBinding>> = vocabularyBindings,
  vocabulary: PublishedVocabulary | undefined = publishedVocabulary(version),
): boolean {
  if (vocabulary === undefined || !Object.hasOwn(bindings, schemaName)) return false;
  return conforms(bindings[schemaName], value, { version, vocabulary, bindings }, 0);
}

// Shapes of src/generated/vocabulary.ts (written by scripts/codegen/vocabulary.ts).
// No imports, so the generated file and the generator can both use them.

/** A numeric range of one published version, already multiplied by the API scale (ADR 0004). */
export interface ScaledRange {
  readonly minimum: number;
  readonly maximum: number;
  /** Exact in binary (a multiple of 2^-20), so `value % multipleOf` is exact. */
  readonly multipleOf: number;
}

/** What one published vocabulary version defines, limited to what the API binds. */
export interface PublishedVocabulary {
  /** Ids per namespace (`methods`, `flavour_notes`, ...). A namespace the version lacks is absent. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /** Ranges by `<file>.<path>@<scale>` (for example `brew.ranges.dose_g@10`). */
  readonly ranges: Readonly<Record<string, ScaledRange>>;
  /** Plain numbers by `<file>.<path>` (for example `flavour_notes.max_picks`). */
  readonly values: Readonly<Record<string, number>>;
}

/**
 * How a contract schema is bound to the vocabulary, from the `x-vocabulary*`
 * tags of contracts/openapi.yaml. A node is one of: `ref`; `list`; `range`;
 * `version`; `properties` with optional `keys`; `items` with optional
 * `maxItems`; or `{}`, which binds nothing.
 */
export interface VocabularyBinding {
  /** Another component schema, by name. */
  readonly ref?: string;
  /** `x-vocabulary`: the value is an id of this namespace in the request's version. */
  readonly list?: string;
  /** `x-vocabulary-range` (with `x-vocabulary-scale`): a key of `PublishedVocabulary.ranges`. */
  readonly range?: string;
  /** `x-vocabulary-version`: the value names a published version. */
  readonly version?: true;
  /** Object properties that bind something. */
  readonly properties?: Readonly<Record<string, VocabularyBinding>>;
  /** `x-vocabulary-keys`: every property name is an id of this namespace in the request's version. */
  readonly keys?: string;
  /** Array items. */
  readonly items?: VocabularyBinding;
  /** `x-vocabulary-max-items`: a key of `PublishedVocabulary.values`, the array's maximum length. */
  readonly maxItems?: string;
}

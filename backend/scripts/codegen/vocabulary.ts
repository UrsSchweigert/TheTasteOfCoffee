// Writes the source of src/generated/vocabulary.ts: what each published
// vocabulary version defines (contracts/vocabulary/v<N>/) and how the API binds
// to it (the x-vocabulary* tags of contracts/openapi.yaml). The API checks each
// request against the version it names (ADR 0004) with this data, so no list,
// range or limit is written by hand anywhere in the backend (CLAUDE.md,
// invariant 2).
//
// A version is published when every file says `"status": "published"`. It must
// then have a lock (`v<N>.lock.json`) that matches its files byte for byte,
// hashed as contracts/lib/lock.mjs does (CRLF read as LF); otherwise generation
// fails, so an edited published version can never reach the backend. Draft
// versions are left out: a request naming one is rejected.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublishedVocabulary, ScaledRange, VocabularyBinding } from '../../src/vocabulary/types.ts';

export class VocabularyGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VocabularyGenerationError';
  }
}

type JsonObject = Record<string, unknown>;

const SCHEMAS_PREFIX = '#/components/schemas/';
const VERSION_DIR = /^v([1-9][0-9]*)$/;
/** Tags this generator understands. Any other `x-vocabulary*` tag fails. */
const VOCABULARY_TAGS = new Set([
  'x-vocabulary',
  'x-vocabulary-range',
  'x-vocabulary-scale',
  'x-vocabulary-keys',
  'x-vocabulary-max-items',
  'x-vocabulary-version',
]);
/** Smallest step the contract lint allows (contracts/README.md, Decimal steps). */
const STEP_UNIT = 2 ** -20;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new VocabularyGenerationError(message);
}

/** The same rounding as contracts/lib/openapi.mjs, so 0.1 * 10 is 1. */
function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

// ---- vocabulary files ----

export interface VersionFiles {
  readonly version: number;
  /** `{ <file name without .json>: parsed content }`. */
  readonly files: Readonly<Record<string, unknown>>;
  /** sha256 per file name, of the canonical bytes. */
  readonly hashes: Readonly<Record<string, string>>;
  /** The parsed lock file, if there is one. */
  readonly lock: unknown;
}

function canonicalHash(bytes: Buffer): string {
  const canonical = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Every `v<N>/` directory under `vocabularyDir`, ascending, with its files and lock. */
export function readVocabularyDir(vocabularyDir: string): VersionFiles[] {
  const versions: VersionFiles[] = [];
  for (const entry of readdirSync(vocabularyDir, { withFileTypes: true })) {
    const match = VERSION_DIR.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const version = Number(match[1]);
    const dir = join(vocabularyDir, entry.name);
    const files: Record<string, unknown> = {};
    const hashes: Record<string, string> = {};
    for (const name of readdirSync(dir).sort()) {
      const bytes = readFileSync(join(dir, name));
      hashes[name] = canonicalHash(bytes);
      if (name.endsWith('.json')) files[name.slice(0, -'.json'.length)] = JSON.parse(bytes.toString('utf8')) as unknown;
    }
    const lockFile = join(vocabularyDir, `v${String(version)}.lock.json`);
    const lock: unknown = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : undefined;
    versions.push({ version, files, hashes, lock });
  }
  return versions.sort((a, b) => a.version - b.version);
}

function isPublished({ version, files, hashes, lock }: VersionFiles): boolean {
  const statuses = Object.values(files).map((file) => (isObject(file) ? file.status : undefined));
  if (statuses.length === 0 || !statuses.every((status) => status === 'published')) {
    if (statuses.some((status) => status === 'published')) fail(`v${String(version)}: some files are published, some are not`);
    return false;
  }
  if (!isObject(lock) || lock.version !== version || lock.algorithm !== 'sha256' || !isObject(lock.files)) {
    fail(`v${String(version)}: published, but v${String(version)}.lock.json is missing or malformed`);
  }
  const locked = lock.files;
  const names = new Set([...Object.keys(locked), ...Object.keys(hashes)]);
  for (const name of names) {
    if (locked[name] !== hashes[name]) fail(`v${String(version)}/${name}: does not match v${String(version)}.lock.json`);
  }
  return true;
}

/** Ids per namespace, at any depth (contracts/README.md, File shapes: the property holding the array names the list). */
function collectLists(files: Readonly<Record<string, unknown>>): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && child.length > 0 && child.every((item) => isObject(item) && typeof item.id === 'string')) {
        const ids = (lists[key] ??= []);
        for (const item of child as JsonObject[]) ids.push(item.id as string);
      }
      walk(child);
    }
  };
  for (const content of Object.values(files)) walk(content);
  return lists;
}

function lookup(files: Readonly<Record<string, unknown>>, dotted: string): unknown {
  let node: unknown = files;
  for (const key of dotted.split('.')) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

// ---- bindings from the contract ----

interface Uses {
  readonly lists: Set<string>;
  /** `<path>@<scale>` to its path and scale. */
  readonly ranges: Map<string, { path: string; scale: number }>;
  readonly values: Set<string>;
}

function bindingOf(where: string, schema: unknown, uses: Uses, componentNames: ReadonlySet<string>): VocabularyBinding {
  if (!isObject(schema)) fail(`${where}: not a schema object`);
  for (const key of Object.keys(schema)) {
    if (key.startsWith('x-vocabulary') && !VOCABULARY_TAGS.has(key)) fail(`${where}: unknown tag ${key}`);
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') fail(`${where}: ${key} is not supported`);
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.startsWith(SCHEMAS_PREFIX) ? schema.$ref.slice(SCHEMAS_PREFIX.length) : '';
    if (!componentNames.has(name)) fail(`${where}: unresolvable $ref`);
    return { ref: name };
  }
  if (typeof schema['x-vocabulary'] === 'string') {
    uses.lists.add(schema['x-vocabulary']);
    return { list: schema['x-vocabulary'] };
  }
  if (schema['x-vocabulary-range'] !== undefined) {
    const path = schema['x-vocabulary-range'];
    const scale = schema['x-vocabulary-scale'] ?? 1;
    if (typeof path !== 'string' || typeof scale !== 'number' || !Number.isInteger(scale) || scale < 1) {
      fail(`${where}: x-vocabulary-range needs a path and an optional positive integer x-vocabulary-scale`);
    }
    const key = `${path}@${String(scale)}`;
    uses.ranges.set(key, { path, scale });
    return { range: key };
  }
  if (schema['x-vocabulary-scale'] !== undefined) fail(`${where}: x-vocabulary-scale without x-vocabulary-range`);
  if (schema['x-vocabulary-version'] !== undefined) {
    if (schema['x-vocabulary-version'] !== true) fail(`${where}: x-vocabulary-version must be true`);
    return { version: true };
  }
  if (schema.type === 'object') {
    const properties: Record<string, VocabularyBinding> = {};
    const declared = isObject(schema.properties) ? schema.properties : {};
    for (const [name, child] of Object.entries(declared)) {
      properties[name] = bindingOf(`${where}.properties.${name}`, child, uses, componentNames);
    }
    const keys = schema['x-vocabulary-keys'];
    if (keys !== undefined && typeof keys !== 'string') fail(`${where}: x-vocabulary-keys must name a list`);
    if (keys !== undefined) uses.lists.add(keys);
    return keys === undefined ? { properties } : { properties, keys };
  }
  if (schema['x-vocabulary-keys'] !== undefined) fail(`${where}: x-vocabulary-keys on a non-object`);
  if (schema.type === 'array') {
    const items = bindingOf(`${where}.items`, schema.items, uses, componentNames);
    const maxItems = schema['x-vocabulary-max-items'];
    if (maxItems !== undefined && typeof maxItems !== 'string') fail(`${where}: x-vocabulary-max-items must name a value`);
    if (maxItems !== undefined) uses.values.add(maxItems);
    return maxItems === undefined ? { items } : { items, maxItems };
  }
  if (schema['x-vocabulary-max-items'] !== undefined) fail(`${where}: x-vocabulary-max-items on a non-array`);
  return {};
}

function scaledRange(version: number, path: string, scale: number, raw: unknown): ScaledRange | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw) || typeof raw.minimum !== 'number' || typeof raw.maximum !== 'number' || typeof raw.multipleOf !== 'number') {
    fail(`v${String(version)}: ${path} is not a range`);
  }
  const range = { minimum: round(raw.minimum * scale), maximum: round(raw.maximum * scale), multipleOf: round(raw.multipleOf * scale) };
  if (range.multipleOf <= 0 || !Number.isInteger(range.multipleOf / STEP_UNIT)) {
    fail(`v${String(version)}: ${path} times ${String(scale)} has a step that is not exact in binary; scale it (ADR 0004)`);
  }
  return range;
}

/** The generated module's source. */
export function generateVocabularySource(document: unknown, versions: readonly VersionFiles[]): string {
  if (!isObject(document) || !isObject(document.components) || !isObject(document.components.schemas)) {
    fail('contract: components.schemas missing');
  }
  const schemas = document.components.schemas;
  const componentNames = new Set(Object.keys(schemas));
  const uses: Uses = { lists: new Set(), ranges: new Map(), values: new Set() };
  const bindings: Record<string, VocabularyBinding> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    bindings[name] = bindingOf(`components.schemas.${name}`, schema, uses, componentNames);
  }

  const published: Record<number, PublishedVocabulary> = {};
  for (const entry of versions) {
    if (!isPublished(entry)) continue;
    const all = collectLists(entry.files);
    const lists: Record<string, string[]> = {};
    for (const namespace of [...uses.lists].sort()) {
      const ids = all[namespace];
      if (ids !== undefined) lists[namespace] = ids;
    }
    const ranges: Record<string, ScaledRange> = {};
    for (const [key, { path, scale }] of [...uses.ranges].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const range = scaledRange(entry.version, path, scale, lookup(entry.files, path));
      if (range !== undefined) ranges[key] = range;
    }
    const values: Record<string, number> = {};
    for (const path of [...uses.values].sort()) {
      const value = lookup(entry.files, path);
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`v${String(entry.version)}: ${path} is not a count`);
      values[path] = value;
    }
    published[entry.version] = { lists, ranges, values };
  }
  if (Object.keys(published).length === 0) fail('no published vocabulary version');

  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  return [
    '// Generated by backend/scripts/generate-contract.ts from the published versions in',
    '// contracts/vocabulary and the x-vocabulary* tags of contracts/openapi.yaml.',
    '// Do not edit. Change the contract, then run `npm run generate` in backend/.',
    '',
    "import type { PublishedVocabulary, VocabularyBinding } from '../vocabulary/types.ts';",
    '',
    '/** Every published vocabulary version, limited to the lists, ranges and values the API binds. */',
    `export const publishedVocabularies: Readonly<Record<number, PublishedVocabulary>> = ${json(published)};`,
    '',
    '/** How each component schema of contracts/openapi.yaml binds to the vocabulary. */',
    `export const vocabularyBindings: Readonly<Record<string, VocabularyBinding>> = ${json(bindings)};`,
    '',
  ].join('\n');
}

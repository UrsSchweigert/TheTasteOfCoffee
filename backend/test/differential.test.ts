// Checks that each generated zod schema accepts exactly what the JSON Schema in
// contracts/openapi.yaml accepts, by running both on the same values: the valid
// fixtures and every single-step mutation of them (each field removed, replaced
// by each value of a pool, or joined by an unknown property). ajv in strict
// mode (strictRequired off for `not: { required }`, as in contracts/) with
// ajv-formats is the reference.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { OPENAPI_FILE, parseOpenApi } from '../scripts/codegen/paths.ts';
import { componentSchemas } from '../src/generated/contract.ts';
import { isDateTime } from '../src/contract/formats.ts';
import {
  EAN13,
  ULID,
  validBean,
  validBeanCreate,
  validBrewInput,
  validBrewPage,
  validProfile,
  validRecipeInput,
  validShelfEntryInput,
} from './fixtures.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const VOCABULARY_KEYWORDS = [
  'x-vocabulary',
  'x-vocabulary-range',
  'x-vocabulary-scale',
  'x-vocabulary-keys',
  'x-vocabulary-max-items',
  'x-vocabulary-version',
  'x-i18n-languages',
];

type Name = keyof typeof componentSchemas;

function loadComponents(): Record<string, unknown> {
  const document = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')) as { components: { schemas: Record<string, unknown> } };
  const text = JSON.stringify(document.components.schemas).replaceAll('#/components/schemas/', '#/$defs/');
  return JSON.parse(text) as Record<string, unknown>;
}

const defs = loadComponents();

/** Every property name any component schema defines. */
const PROPERTY_NAMES: string[] = [...new Set(collectPropertyNames(defs))].sort();

function collectPropertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPropertyNames);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own =
    typeof record.properties === 'object' && record.properties !== null ? Object.keys(record.properties) : [];
  return [...own, ...Object.values(record).flatMap(collectPropertyNames)];
}
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
ajv.addVocabulary(VOCABULARY_KEYWORDS);
ajv.addSchema({ $id: 'cupmark:contract', $defs: defs });

function ajvAccepts(name: string, value: unknown): boolean {
  const validate = ajv.getSchema(`cupmark:contract#/$defs/${name}`);
  if (!validate) throw new Error(`ajv has no schema ${name}`);
  const result = validate(value);
  if (typeof result !== 'boolean') throw new Error(`ajv schema ${name} is asynchronous`);
  return result;
}

function zodAccepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

/**
 * ajv-formats accepts three date-time forms that RFC 3339 section 5.6 does
 * not: a space instead of T, an offset without colon (+0100) and an offset
 * without minutes (+01). The backend follows RFC 3339 and rejects them.
 */
const AJV_LENIENT_DATE_TIMES = ['2026-11-25 07:30:00Z', '2026-11-25T07:30:00+0100', '2026-11-25T07:30:00+01'];

const POOL: unknown[] = [
  null,
  true,
  false,
  0,
  -1,
  0.5,
  1,
  1.5,
  7.25,
  7.5,
  7.500000000000001,
  9,
  10,
  10.5,
  49,
  50,
  80,
  100,
  101,
  150.5,
  1000,
  1001,
  1500,
  1501,
  172800,
  172801,
  2 ** 53,
  '',
  'x',
  '1',
  'v60',
  'espresso',
  'cold',
  'berry',
  'washed',
  'medium',
  'g_250',
  'under_15',
  'de',
  'tap',
  'oat',
  'high',
  ULID,
  ULID.toLowerCase(),
  `${ULID}0`,
  EAN13,
  '400638133393',
  '4006381333931a',
  'abc_DEF-123',
  'a/b',
  '2026-11-25',
  '2028-02-29',
  '2026-02-29',
  '2026-11-31',
  '2026-11-25T07:30:00Z',
  '2026-11-25t07:30:00.5z',
  '2026-11-25T07:30:00-05:30',
  '2026-11-25T07:30Z',
  '2026-11-25T24:00:00Z',
  '2016-12-31T23:59:60Z',
  '2016-12-31T23:58:60Z',
  [],
  ['berry'],
  ['berry', 'berry'],
  ['berry', 'cherry', 'plum', 'peach', 'apricot'],
  ['berry', 'cherry', 'plum', 'peach', 'apricot', 'apple'],
  [1, 2],
  {},
  { method: 'v60' },
  { aroma: 7 },
  { contribute_to_aggregates: true },
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Every value one mutation away from `root`. */
function* mutations(root: unknown): Generator {
  type Path = (string | number)[];
  function* paths(value: unknown, path: Path): Generator<Path> {
    yield path;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) yield* paths(value[i], [...path, i]);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) yield* paths(item, [...path, key]);
    }
  }
  function at(value: unknown, path: Path): unknown {
    let current = value;
    for (const step of path) current = (current as Record<string | number, unknown>)[step];
    return current;
  }
  function container(value: unknown, path: Path): Record<string | number, unknown> {
    return at(value, path) as Record<string | number, unknown>;
  }

  for (const path of paths(root, [])) {
    const last = path.at(-1);
    const target = at(root, path);
    if (path.length > 0 && last !== undefined) {
      const parentPath = path.slice(0, -1);
      for (const replacement of POOL) {
        const copy = clone(root);
        container(copy, parentPath)[last] = clone(replacement);
        yield copy;
      }
      const removed = clone(root);
      const parent = container(removed, parentPath);
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else Reflect.deleteProperty(parent, last);
      yield removed;
    }
    if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
      const extended = clone(root);
      container(extended, path).unknown_property = 1;
      yield extended;
      // Adding a property the fixture lacks reaches dependentRequired and
      // not: { required } (for example water_temp_special next to water_temp_c).
      for (const name of PROPERTY_NAMES) {
        if (Object.hasOwn(target, name)) continue;
        for (const addition of POOL) {
          const added = clone(root);
          container(added, path)[name] = clone(addition);
          yield added;
        }
      }
    }
  }
}

const FIXTURES: [Name, unknown][] = [
  ['BrewInput', validBrewInput()],
  ['RecipeInput', validRecipeInput()],
  ['BeanCreate', validBeanCreate()],
  ['Bean', validBean()],
  ['ShelfEntryInput', validShelfEntryInput()],
  ['Profile', validProfile()],
  ['BrewPage', validBrewPage()],
];

describe('generated zod schemas match the JSON Schema of the contract', () => {
  it('compiles every component in ajv', () => {
    for (const name of Object.keys(componentSchemas)) expect(ajv.getSchema(`cupmark:contract#/$defs/${name}`)).toBeDefined();
  });

  it.each(FIXTURES)('%s: fixture and every one-step mutation agree', (name, fixture) => {
    const schema = componentSchemas[name];
    expect(ajvAccepts(name, fixture)).toBe(true);
    expect(zodAccepts(schema, fixture)).toBe(true);
    let checked = 0;
    let accepted = 0;
    for (const candidate of mutations(fixture)) {
      const byAjv = ajvAccepts(name, candidate);
      const byZod = zodAccepts(schema, candidate);
      if (byAjv !== byZod) {
        throw new Error(`${name} disagrees (ajv ${String(byAjv)}, zod ${String(byZod)}) on ${JSON.stringify(candidate)}`);
      }
      checked += 1;
      if (byZod) accepted += 1;
    }
    // Both outcomes must occur, or the comparison proves nothing.
    expect(checked).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(checked);
  });

  it.each(Object.keys(componentSchemas) as Name[])('%s: every pool value agrees', (name) => {
    for (const value of POOL) {
      expect([name, value, zodAccepts(componentSchemas[name], value)]).toEqual([name, value, ajvAccepts(name, value)]);
    }
  });

  it.each(AJV_LENIENT_DATE_TIMES)('differs from ajv-formats only where RFC 3339 is stricter: %s', (value) => {
    expect(ajvAccepts('Timestamp', value)).toBe(true);
    expect(isDateTime(value)).toBe(false);
    expect(zodAccepts(componentSchemas.Timestamp, value)).toBe(false);
  });
});

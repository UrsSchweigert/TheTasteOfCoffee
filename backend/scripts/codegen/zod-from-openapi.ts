// Translates the component schemas of contracts/openapi.yaml into zod source.
//
// Hand-written on purpose: the contract uses a small, linted subset of JSON
// Schema 2020-12 (contracts/lib/openapi.mjs, SCHEMA_KEYWORDS), and every
// keyword of that subset is either translated exactly here or rejected with
// an error. Nothing is dropped silently. Off-the-shelf converters translate
// a far larger language and are lossy in places that matter here (for
// example `dependentRequired`, `not: { required }`, `uniqueItems`, exact
// `multipleOf`), so checking one of them would be more work than this file.
//
// Supported, and how:
//   $ref                local `#/components/schemas/<Name>` only; siblings: description
//   type string         enum (strings only) | pattern (compiled with the `u` flag, as
//                       ajv does) | format date, date-time (real calendar checks in
//                       src/contract/formats.ts) | minLength, maxLength (code points)
//                       | response-only free text: `x-free-text-from: open_food_facts`
//                       with `readOnly: true` and `maxLength` (ADR 0005), emitted as a
//                       string bounded in code points; without the marker a string
//                       with no enum, pattern or format throws
//   type integer        z.int(); minimum, maximum (inclusive), multipleOf (exact `%`,
//                       dyadic steps only, as the contract lint requires)
//   type number         z.number(); minimum, maximum (inclusive), multipleOf (as above)
//   type boolean        z.boolean()
//   type object         z.strictObject (additionalProperties must be false);
//                       properties, required, dependentRequired, not: { required }
//   type array          items (one schema), minItems, maxItems, uniqueItems
//   annotations         description, title, the x-vocabulary* tags and x-health-status
//                       (checked by the contracts tests, nothing to enforce at runtime)
// Everything else (allOf, oneOf, anyOf, const, default, exclusive bounds, ...) throws.

export class ContractGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractGenerationError';
  }
}

type JsonObject = Record<string, unknown>;

const SCHEMAS_PREFIX = '#/components/schemas/';

const ANNOTATIONS = new Set([
  'description',
  'title',
  'x-vocabulary',
  'x-vocabulary-range',
  'x-vocabulary-scale',
  'x-vocabulary-keys',
  'x-vocabulary-max-items',
  'x-vocabulary-version',
  'x-i18n-languages',
  'x-health-status',
]);

/** The one source of response-only free text (contracts/lib/openapi.mjs, FREE_TEXT_SOURCES). */
const FREE_TEXT_KEYWORD = 'x-free-text-from';
const FREE_TEXT_SOURCES: ReadonlySet<unknown> = new Set(['open_food_facts']);

const KEYWORDS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  string: new Set(['type', 'enum', 'pattern', 'format', 'minLength', 'maxLength', 'readOnly', FREE_TEXT_KEYWORD]),
  integer: new Set(['type', 'minimum', 'maximum', 'multipleOf']),
  number: new Set(['type', 'minimum', 'maximum', 'multipleOf']),
  boolean: new Set(['type']),
  object: new Set(['type', 'properties', 'required', 'additionalProperties', 'dependentRequired', 'not']),
  array: new Set(['type', 'items', 'minItems', 'maxItems', 'uniqueItems']),
};

const FORMAT_CHECKS: Record<string, { helper: string; message: string }> = {
  date: { helper: 'isFullDate', message: 'Invalid date' },
  'date-time': { helper: 'isDateTime', message: 'Invalid date-time' },
};

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;
const PROPERTY_NAME = /^[a-z][a-z0-9_]*$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new ContractGenerationError(`${path}: ${message}`);
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function numberLiteral(path: string, keyword: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `${keyword} must be a finite number`);
  return String(value);
}

function nonNegativeInteger(path: string, keyword: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, `${keyword} must be a non-negative integer`);
  }
  return value;
}

function nameList(path: string, keyword: string, value: unknown, defined: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, `${keyword} must be a non-empty array of property names`);
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') fail(path, `${keyword} must hold strings`);
    if (!defined.has(item)) fail(path, `${keyword} names "${item}", which is not in properties`);
    if (names.includes(item)) fail(path, `${keyword} names "${item}" twice`);
    names.push(item);
  }
  return names;
}

class Emitter {
  readonly helpers = new Set<string>();
  readonly refs = new Set<string>();
  private readonly componentNames: ReadonlySet<string>;

  constructor(componentNames: ReadonlySet<string>) {
    this.componentNames = componentNames;
  }

  schema(path: string, schema: unknown, indent: string): string {
    if (!isObject(schema)) fail(path, 'schema must be an object');

    if ('$ref' in schema) {
      for (const key of Object.keys(schema)) {
        if (key !== '$ref' && key !== 'description') fail(path, `$ref with sibling keyword "${key}" is not supported`);
      }
      const ref = schema.$ref;
      if (typeof ref !== 'string' || !ref.startsWith(SCHEMAS_PREFIX)) fail(path, `$ref must start with ${SCHEMAS_PREFIX}`);
      const target = ref.slice(SCHEMAS_PREFIX.length);
      if (!this.componentNames.has(target)) fail(path, `$ref target "${target}" does not exist`);
      this.refs.add(target);
      return `${target}Schema`;
    }

    const type = schema.type;
    if (typeof type !== 'string') fail(path, 'schema needs exactly one `type` (or a $ref)');
    const allowed = KEYWORDS_BY_TYPE[type];
    if (!allowed) fail(path, `type "${type}" is not supported`);
    for (const key of Object.keys(schema)) {
      if (!allowed.has(key) && !ANNOTATIONS.has(key)) {
        fail(path, `keyword "${key}" is not supported on type ${type}`);
      }
    }

    switch (type) {
      case 'string':
        return this.string(path, schema, indent);
      case 'integer':
        return this.numeric(path, schema, 'z.int()');
      case 'number':
        return this.numeric(path, schema, 'z.number()');
      case 'boolean':
        return 'z.boolean()';
      case 'object':
        return this.object(path, schema, indent);
      default:
        return this.array(path, schema, indent);
    }
  }

  private string(path: string, schema: JsonObject, indent: string): string {
    const isFreeText = FREE_TEXT_KEYWORD in schema;
    if ('readOnly' in schema && !isFreeText) fail(path, `readOnly is only supported on response-only free text (${FREE_TEXT_KEYWORD})`);
    if (isFreeText) {
      if (!FREE_TEXT_SOURCES.has(schema[FREE_TEXT_KEYWORD])) fail(path, `${FREE_TEXT_KEYWORD} must be open_food_facts`);
      if (schema.readOnly !== true) fail(path, 'response-only free text needs readOnly: true');
      for (const key of ['enum', 'pattern', 'format']) {
        if (key in schema) fail(path, `${FREE_TEXT_KEYWORD} together with ${key} is not supported`);
      }
      if (!('maxLength' in schema)) fail(path, 'response-only free text needs maxLength');
      return this.lengths(path, schema, 'z.string()');
    }

    if ('enum' in schema) {
      const values = schema.enum;
      if (Object.keys(schema).some((key) => KEYWORDS_BY_TYPE.string?.has(key) && key !== 'type' && key !== 'enum')) {
        fail(path, 'enum together with other string keywords is not supported');
      }
      if (!Array.isArray(values) || values.length === 0) fail(path, 'enum must be a non-empty array');
      const seen = new Set<string>();
      for (const value of values) {
        if (typeof value !== 'string') fail(path, 'enum values must be strings');
        if (seen.has(value)) fail(path, `enum value "${value}" appears twice`);
        seen.add(value);
      }
      const items = [...seen].map(literal);
      const oneLine = `z.enum([${items.join(', ')}])`;
      if (oneLine.length <= 100) return oneLine;
      return `z.enum([\n${items.map((item) => `${indent}  ${item},`).join('\n')}\n${indent}])`;
    }

    if (!('pattern' in schema) && !('format' in schema)) {
      fail(path, 'a string needs enum, pattern or format (no free text)');
    }
    let code = 'z.string()';
    if ('pattern' in schema) {
      const pattern = schema.pattern;
      if (typeof pattern !== 'string') fail(path, 'pattern must be a string');
      try {
        new RegExp(pattern, 'u');
      } catch {
        fail(path, `pattern ${pattern} is not a valid unicode regular expression`);
      }
      code += `.regex(new RegExp(${literal(pattern)}, 'u'))`;
    }
    if ('format' in schema) {
      const format = schema.format;
      const check = typeof format === 'string' ? FORMAT_CHECKS[format] : undefined;
      if (!check) fail(path, `format ${String(format)} is not supported`);
      this.helpers.add(check.helper);
      code += `.refine(${check.helper}, { error: ${literal(check.message)} })`;
    }
    return this.lengths(path, schema, code);
  }

  /** minLength and maxLength in code points, as JSON Schema (and ajv) count them. */
  private lengths(path: string, schema: JsonObject, base: string): string {
    let code = base;
    if ('minLength' in schema) {
      const min = nonNegativeInteger(path, 'minLength', schema.minLength);
      this.helpers.add('codePointLength');
      code += `.refine((value) => codePointLength(value) >= ${String(min)}, { error: 'Too short' })`;
    }
    if ('maxLength' in schema) {
      const max = nonNegativeInteger(path, 'maxLength', schema.maxLength);
      this.helpers.add('codePointLength');
      code += `.refine((value) => codePointLength(value) <= ${String(max)}, { error: 'Too long' })`;
    }
    return code;
  }

  private numeric(path: string, schema: JsonObject, base: string): string {
    let code = base;
    if ('minimum' in schema) code += `.min(${numberLiteral(path, 'minimum', schema.minimum)})`;
    if ('maximum' in schema) code += `.max(${numberLiteral(path, 'maximum', schema.maximum)})`;
    if ('multipleOf' in schema) {
      const step = numberLiteral(path, 'multipleOf', schema.multipleOf);
      if (Number(step) <= 0) fail(path, 'multipleOf must be greater than 0');
      // Same rule as the contract lint (isDyadic in contracts/lib/openapi.mjs):
      // a step must be a multiple of 2^-20, so it is exact in binary.
      if (!Number.isInteger(Number(step) * 2 ** 20)) {
        fail(path, `multipleOf ${step} is not exact in binary floating point; use a scaled integer`);
      }
      // `%` on doubles is exact (IEEE 754 remainder), so with a dyadic step a
      // value passes only if it is an exact multiple. zod's own multipleOf
      // allows a relative tolerance and would accept near misses.
      code += `.refine((value) => value % ${step} === 0, { error: 'Not a multiple of ${step}' })`;
    }
    return code;
  }

  private object(path: string, schema: JsonObject, indent: string): string {
    if (schema.additionalProperties !== false) fail(path, 'objects need additionalProperties: false');
    const properties = schema.properties ?? {};
    if (!isObject(properties)) fail(path, 'properties must be an object');
    const names = Object.keys(properties);
    const defined = new Set(names);
    const required = new Set('required' in schema ? nameList(path, 'required', schema.required, defined) : []);

    const inner = `${indent}  `;
    const fields = names.map((name) => {
      if (!PROPERTY_NAME.test(name)) fail(path, `property name "${name}" is not snake_case`);
      const value = this.schema(`${path}.properties.${name}`, properties[name], inner);
      return `${inner}${name}: ${value}${required.has(name) ? '' : '.optional()'},`;
    });
    let code = fields.length === 0 ? 'z.strictObject({})' : `z.strictObject({\n${fields.join('\n')}\n${indent}})`;

    const checks: string[] = [];
    if ('dependentRequired' in schema) {
      const dependent = schema.dependentRequired;
      if (!isObject(dependent)) fail(path, 'dependentRequired must be an object');
      for (const [trigger, needs] of Object.entries(dependent)) {
        if (!defined.has(trigger)) fail(path, `dependentRequired names "${trigger}", which is not in properties`);
        for (const need of nameList(path, `dependentRequired.${trigger}`, needs, defined)) {
          checks.push(
            `${inner}if (isPresent(value, ${literal(trigger)}) && !isPresent(value, ${literal(need)})) {\n` +
              `${inner}  ctx.addIssue({ code: 'custom', message: ${literal(`${trigger} requires ${need}`)}, path: [${literal(need)}] });\n` +
              `${inner}}`,
          );
        }
      }
    }
    if ('not' in schema) {
      const not = schema.not;
      if (!isObject(not) || Object.keys(not).length !== 1 || !('required' in not)) {
        fail(path, 'not is only supported as { required: [...] }');
      }
      const together = nameList(path, 'not.required', not.required, defined);
      const condition = together.map((name) => `isPresent(value, ${literal(name)})`).join(' && ');
      checks.push(
        `${inner}if (${condition}) {\n` +
          `${inner}  ctx.addIssue({ code: 'custom', message: ${literal(`${together.join(', ')} exclude each other`)}, path: [] });\n` +
          `${inner}}`,
      );
    }
    if (checks.length > 0) {
      this.helpers.add('isPresent');
      code += `.superRefine((value, ctx) => {\n${checks.join('\n')}\n${indent}})`;
    }
    return code;
  }

  private array(path: string, schema: JsonObject, indent: string): string {
    if (!('items' in schema)) fail(path, 'arrays need items');
    let code = `z.array(${this.schema(`${path}.items`, schema.items, indent)})`;
    if ('minItems' in schema) code += `.min(${String(nonNegativeInteger(path, 'minItems', schema.minItems))})`;
    if ('maxItems' in schema) code += `.max(${String(nonNegativeInteger(path, 'maxItems', schema.maxItems))})`;
    if ('uniqueItems' in schema) {
      if (typeof schema.uniqueItems !== 'boolean') fail(path, 'uniqueItems must be a boolean');
      if (schema.uniqueItems) {
        this.helpers.add('hasUniqueItems');
        code += `.refine(hasUniqueItems, { error: 'Items must be unique' })`;
      }
    }
    return code;
  }
}

/** Orders components so that every schema is declared after the ones it references. */
function topologicalOrder(names: readonly string[], dependencies: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, trail: readonly string[]): void => {
    const current = state.get(name);
    if (current === 'done') return;
    if (current === 'visiting') {
      fail(`components.schemas.${name}`, `reference cycle ${[...trail, name].join(' -> ')} is not supported`);
    }
    state.set(name, 'visiting');
    for (const dependency of dependencies.get(name) ?? []) visit(dependency, [...trail, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of names) visit(name, []);
  return order;
}

/** Returns the TypeScript source of the generated contract module. */
export function generateContractSource(document: unknown): string {
  if (!isObject(document)) fail('document', 'must be an object');
  const components = document.components;
  if (!isObject(components)) fail('components', 'missing');
  const schemas = components.schemas;
  if (!isObject(schemas) || Object.keys(schemas).length === 0) fail('components.schemas', 'missing or empty');

  const names = Object.keys(schemas);
  for (const name of names) {
    if (!COMPONENT_NAME.test(name)) fail(`components.schemas.${name}`, 'name must be PascalCase');
  }
  const componentNames = new Set(names);
  const helpers = new Set<string>();
  const bodies = new Map<string, string>();
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const name of names) {
    const emitter = new Emitter(componentNames);
    bodies.set(name, emitter.schema(`components.schemas.${name}`, schemas[name], ''));
    dependencies.set(name, emitter.refs);
    for (const helper of emitter.helpers) helpers.add(helper);
  }

  const lines: string[] = [
    '// Generated by backend/scripts/generate-contract.ts from contracts/openapi.yaml.',
    '// Do not edit. Change the contract, then run `npm run generate` in backend/.',
    '',
    "import { z } from 'zod';",
  ];
  if (helpers.size > 0) {
    lines.push(`import { ${[...helpers].sort().join(', ')} } from '../contract/formats.ts';`);
  }
  const ordered = topologicalOrder(names, dependencies);
  for (const name of ordered) {
    lines.push('', `export const ${name}Schema = ${bodies.get(name) ?? ''};`, `export type ${name} = z.infer<typeof ${name}Schema>;`);
  }
  lines.push(
    '',
    '/** Every component schema of contracts/openapi.yaml, by name. */',
    'export const componentSchemas = {',
    ...names.map((name) => `  ${name}: ${name}Schema,`),
    '} as const;',
    '',
  );
  return lines.join('\n');
}

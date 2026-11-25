import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENERATED_FILE, OPENAPI_FILE, generateFromContract, parseOpenApi } from '../scripts/codegen/paths.ts';
import { ContractGenerationError, generateContractSource } from '../scripts/codegen/zod-from-openapi.ts';
import { componentSchemas } from '../src/generated/contract.ts';

function documentWith(schemas: Record<string, unknown>): unknown {
  return { components: { schemas } };
}

function generate(schemas: Record<string, unknown>): string {
  return generateContractSource(documentWith(schemas));
}

describe('no drift', () => {
  it('src/generated/contract.ts is what the generator makes from contracts/openapi.yaml', () => {
    const committed = readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === generateFromContract(), 'run `npm run generate` and commit the result').toBe(true);
  });

  it('exports a schema for every component schema, in contract order', () => {
    const document = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(componentSchemas)).toEqual(Object.keys(document.components.schemas));
  });
});

describe('generator', () => {
  it('declares a referenced schema before the schema that uses it', () => {
    const source = generate({
      Outer: { type: 'object', additionalProperties: false, properties: { inner: { $ref: '#/components/schemas/Inner' } } },
      Inner: { type: 'string', enum: ['a'] },
    });
    expect(source.indexOf('export const InnerSchema')).toBeLessThan(source.indexOf('export const OuterSchema'));
  });

  it('accepts dyadic steps down to 2^-20', () => {
    for (const multipleOf of [1, 0.5, 0.25, 0.75, 2 ** -20]) {
      expect(() => generate({ A: { type: 'number', minimum: 0, maximum: 1, multipleOf } })).not.toThrow();
    }
  });

  it('is deterministic', () => {
    expect(generateFromContract()).toBe(generateFromContract());
  });

  const plainString = { type: 'string', enum: ['a'] };
  const rejected: [string, Record<string, unknown>, RegExp][] = [
    ['allOf', { A: { allOf: [plainString] } }, /exactly one `type`/],
    ['oneOf', { A: { oneOf: [plainString] } }, /exactly one `type`/],
    ['anyOf', { A: { type: 'string', anyOf: [plainString] } }, /keyword "anyOf"/],
    ['const', { A: { type: 'string', const: 'a' } }, /keyword "const"/],
    ['default', { A: { type: 'integer', minimum: 1, maximum: 2, default: 1 } }, /keyword "default"/],
    ['exclusiveMinimum', { A: { type: 'number', exclusiveMinimum: 0 } }, /keyword "exclusiveMinimum"/],
    ['an unknown x- tag', { A: { type: 'string', enum: ['a'], 'x-vocabulary-typo': 'methods' } }, /keyword "x-vocabulary-typo"/],
    ['a misspelt keyword', { A: { type: 'string', patern: '^a$' } }, /keyword "patern"/],
    ['a type list', { A: { type: ['string', 'null'] } }, /exactly one `type`/],
    ['type null', { A: { type: 'null' } }, /type "null" is not supported/],
    ['a free-text string', { A: { type: 'string' } }, /enum, pattern or format/],
    ['a string with only a length', { A: { type: 'string', maxLength: 10 } }, /enum, pattern or format/],
    ['an unknown format', { A: { type: 'string', format: 'email' } }, /format email/],
    ['an invalid pattern', { A: { type: 'string', pattern: '^[a$' } }, /not a valid unicode regular expression/],
    ['a non-string enum', { A: { type: 'string', enum: [1] } }, /enum values must be strings/],
    ['an empty enum', { A: { type: 'string', enum: [] } }, /non-empty/],
    ['a duplicate enum value', { A: { type: 'string', enum: ['a', 'a'] } }, /appears twice/],
    ['enum with pattern', { A: { type: 'string', enum: ['a'], pattern: '^a$' } }, /enum together with/],
    ['a non-numeric bound', { A: { type: 'integer', minimum: '1' } }, /minimum must be a finite number/],
    ['multipleOf 0', { A: { type: 'number', multipleOf: 0 } }, /greater than 0/],
    ['a non-dyadic multipleOf (0.1)', { A: { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.1 } }, /not exact in binary/],
    ['a non-dyadic multipleOf (2^-21)', { A: { type: 'number', minimum: 0, maximum: 1, multipleOf: 2 ** -21 } }, /not exact in binary/],
    ['an open object', { A: { type: 'object', properties: {} } }, /additionalProperties: false/],
    ['additionalProperties as a schema', { A: { type: 'object', additionalProperties: plainString } }, /additionalProperties: false/],
    ['patternProperties', { A: { type: 'object', additionalProperties: false, patternProperties: {} } }, /patternProperties/],
    [
      'required naming an undefined property',
      { A: { type: 'object', additionalProperties: false, properties: {}, required: ['b'] } },
      /not in properties/,
    ],
    [
      'dependentRequired naming an undefined property',
      { A: { type: 'object', additionalProperties: false, properties: { a: plainString }, dependentRequired: { a: ['b'] } } },
      /not in properties/,
    ],
    [
      'a not other than required',
      { A: { type: 'object', additionalProperties: false, properties: { a: plainString }, not: { properties: {} } } },
      /not is only supported/,
    ],
    ['an array without items', { A: { type: 'array', maxItems: 1 } }, /arrays need items/],
    ['prefixItems', { A: { type: 'array', items: plainString, prefixItems: [] } }, /keyword "prefixItems"/],
    ['contains', { A: { type: 'array', items: plainString, contains: plainString } }, /keyword "contains"/],
    ['a $ref with a sibling', { A: { $ref: '#/components/schemas/B', maxItems: 1 }, B: plainString }, /sibling keyword "maxItems"/],
    ['a non-local $ref', { A: { $ref: 'other.yaml#/A' } }, /\$ref must start with/],
    ['a dangling $ref', { A: { $ref: '#/components/schemas/Missing' } }, /does not exist/],
    [
      'a reference cycle',
      {
        A: { type: 'object', additionalProperties: false, properties: { b: { $ref: '#/components/schemas/B' } } },
        B: { type: 'object', additionalProperties: false, properties: { a: { $ref: '#/components/schemas/A' } } },
      },
      /reference cycle/,
    ],
    ['a non-PascalCase component name', { my_schema: plainString }, /PascalCase/],
    [
      'a non-snake_case property name',
      { A: { type: 'object', additionalProperties: false, properties: { __proto__x: plainString } } },
      /not snake_case/,
    ],
  ];

  it.each(rejected)('fails loudly on %s', (_name, schemas, message) => {
    expect(() => generate(schemas)).toThrow(ContractGenerationError);
    expect(() => generate(schemas)).toThrow(message);
  });

  it('fails on a document without component schemas', () => {
    expect(() => generateContractSource({})).toThrow(ContractGenerationError);
    expect(() => generateContractSource(documentWith({}))).toThrow(ContractGenerationError);
  });
});

// Checks of contracts/openapi.yaml. Like lib/vocabulary.mjs, every check is a
// pure function that returns a list of problem strings (empty means ok), so
// tests can feed broken in-memory documents to the same code that guards the
// real file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { CONTRACTS_DIR, collectIds, listVersions, loadI18n, loadVocabulary, mergeIdLists } from './vocabulary.mjs';

export const OPENAPI_FILE = join(CONTRACTS_DIR, 'openapi.yaml');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const STRING_FORMATS = ['date', 'date-time'];
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const JSON_MEDIA_TYPE = 'application/json';
const CSV_MEDIA_TYPE = 'text/csv';
const SCHEMAS_PREFIX = '#/components/schemas/';

/** Extension keywords that bind a schema to the vocabulary. See README.md. */
export const VOCABULARY_KEYWORDS = [
  'x-vocabulary',
  'x-vocabulary-range',
  'x-vocabulary-scale',
  'x-vocabulary-keys',
  'x-vocabulary-max-items',
  'x-vocabulary-version',
  'x-i18n-languages',
];

/**
 * Names that would let a client say who the user is. The user id comes from
 * the token only (CLAUDE.md, invariant 3), so no property or parameter may
 * carry one of these names.
 */
export const IDENTITY_NAMES = [
  'user', 'user_id', 'userid', 'sub', 'subject', 'owner', 'owner_id',
  'account_id', 'cognito_id', 'apple_id', 'identity_id',
];

/** Parses YAML strictly: duplicate keys and other errors throw. */
export function parseOpenApi(text) {
  return parse(text, { uniqueKeys: true, prettyErrors: true, strict: true });
}

export function loadOpenApi(file = OPENAPI_FILE) {
  return parseOpenApi(readFileSync(file, 'utf8'));
}

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (path) => '#/' + path.map((p) => String(p).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

/** Resolves a local `#/...` reference, or returns undefined. */
export function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isMap(node) && !Array.isArray(node)) return undefined;
    if (!Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Every schema root in the document: each entry of components.schemas and
 * every `schema` property anywhere else (parameters, request bodies,
 * responses, headers). `mediaType` is set when the root sits in a
 * `content` map.
 */
export function schemaRoots(doc) {
  const roots = [];
  for (const [name, schema] of Object.entries(doc?.components?.schemas ?? {})) {
    roots.push({ schema, path: ['components', 'schemas', name] });
  }
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, [...path, index]));
      return;
    }
    if (!isMap(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (path.length === 2 && path[0] === 'components' && path[1] === 'schemas') continue;
      if (key === 'schema') {
        const mediaType = path.length >= 2 && path[path.length - 2] === 'content' ? path[path.length - 1] : undefined;
        roots.push({ schema: child, path: [...path, key], mediaType });
        continue;
      }
      walk(child, [...path, key]);
    }
  };
  walk(doc, []);
  return roots;
}

/**
 * Calls `visit(schema, path, context)` for every schema node: the roots and
 * everything nested in properties, items, oneOf, anyOf and not. A `$ref` is
 * followed (once per target) so referenced schemas are visited even if they
 * are not in components.schemas. `context.inNot` is true below `not`, where a
 * schema is a constraint rather than a shape.
 */
export function forEachSchema(doc, visit) {
  const seenRefs = new Set();
  const walk = (schema, path, context) => {
    visit(schema, path, context);
    if (!isMap(schema)) return;
    if (typeof schema.$ref === 'string' && !seenRefs.has(schema.$ref)) {
      seenRefs.add(schema.$ref);
      const target = resolveRef(doc, schema.$ref);
      if (target !== undefined) walk(target, [schema.$ref], { ...context, mediaType: undefined, inNot: false });
    }
    if (isMap(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) walk(child, [...path, 'properties', name], { ...context, mediaType: undefined });
    }
    if (schema.items !== undefined) walk(schema.items, [...path, 'items'], { ...context, mediaType: undefined });
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(schema[key])) schema[key].forEach((child, i) => walk(child, [...path, key, i], { ...context, mediaType: undefined }));
    }
    if (schema.not !== undefined) walk(schema.not, [...path, 'not'], { ...context, mediaType: undefined, inNot: true });
  };
  for (const root of schemaRoots(doc)) {
    // Roots in components.schemas are walked under their $ref name, so a
    // reference to them is not walked a second time.
    const isComponent = root.path[0] === 'components' && root.path[1] === 'schemas' && root.path.length === 3;
    if (isComponent) {
      const ref = SCHEMAS_PREFIX + root.path[2];
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      walk(root.schema, [ref], { inNot: false });
    } else {
      walk(root.schema, root.path, { inNot: false, mediaType: root.mediaType });
    }
  }
}

const isDyadic = (step) => Number.isFinite(step) && step > 0 && Number.isInteger(step * 2 ** 20);
const isAnchored = (pattern) => pattern.startsWith('^') && pattern.endsWith('$') && !pattern.endsWith('\\$');

/**
 * The no-free-text lint. Fails on:
 * - a string without `enum`, an anchored `pattern` or a `format` of date or
 *   date-time (a CSV response body with `contentMediaType: text/csv` is the
 *   one exception);
 * - a number or integer without numeric `minimum` and `maximum`, or with a
 *   `multipleOf` that is not exact in binary floating point (0.1 is not,
 *   0.5 is; send such values as scaled integers);
 * - an object without `additionalProperties: false`, or with `required`
 *   names it does not define;
 * - an array without `items` or `maxItems`;
 * - a schema without a single `type` (unless it is a `$ref` or `oneOf` /
 *   `anyOf`), `allOf` (it defeats additionalProperties: false), a `$ref`
 *   that does not resolve or is not local, `patternProperties`, and a `not`
 *   that is anything but `{ required: [...] }`.
 */
export function lintSchemas(doc) {
  const problems = [];
  const add = (path, message) => problems.push(`${pointerOf(path)}: ${message}`);

  forEachSchema(doc, (schema, path, context) => {
    if (!isMap(schema)) {
      add(path, 'schema is not an object');
      return;
    }
    if (context.inNot) {
      const keys = Object.keys(schema);
      if (keys.length !== 1 || keys[0] !== 'required' || !Array.isArray(schema.required)) {
        add(path, 'not may only hold { required: [...] }');
      }
      return;
    }
    if ('$ref' in schema) {
      if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) add(path, `$ref ${JSON.stringify(schema.$ref)} is not local`);
      else if (resolveRef(doc, schema.$ref) === undefined) add(path, `$ref ${schema.$ref} does not resolve`);
      const extra = Object.keys(schema).filter((k) => !['$ref', 'description'].includes(k));
      if (extra.length > 0) add(path, `$ref has sibling keywords ${extra.join(', ')}`);
      return;
    }
    if ('allOf' in schema) add(path, 'allOf is not allowed (it defeats additionalProperties: false); nest objects instead');
    if ('patternProperties' in schema) add(path, 'patternProperties is not allowed');
    const composed = Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf);
    if (schema.type === undefined) {
      if (!composed) add(path, 'schema has no type');
      return;
    }
    if (typeof schema.type !== 'string' || !SCHEMA_TYPES.includes(schema.type)) {
      add(path, `type must be one of ${SCHEMA_TYPES.join(', ')}, got ${JSON.stringify(schema.type)}`);
      return;
    }

    switch (schema.type) {
      case 'string': {
        const hasEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
        if ('enum' in schema && !(hasEnum && schema.enum.every((v) => typeof v === 'string'))) {
          add(path, 'enum must be a non-empty list of strings');
        }
        const hasPattern = typeof schema.pattern === 'string';
        if (hasPattern && !isAnchored(schema.pattern)) add(path, `pattern ${schema.pattern} is not anchored with ^ and $`);
        const hasFormat = typeof schema.format === 'string';
        if (hasFormat && !STRING_FORMATS.includes(schema.format)) {
          add(path, `format ${schema.format} is not one of ${STRING_FORMATS.join(', ')}`);
        }
        const isCsvBody = context.mediaType === CSV_MEDIA_TYPE && schema.contentMediaType === CSV_MEDIA_TYPE;
        if (!hasEnum && !hasPattern && !hasFormat && !isCsvBody) add(path, 'string without enum, pattern or format');
        break;
      }
      case 'number':
      case 'integer': {
        for (const bound of ['minimum', 'maximum']) {
          if (typeof schema[bound] !== 'number' || !Number.isFinite(schema[bound])) add(path, `${schema.type} without ${bound}`);
        }
        if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
          add(path, 'minimum is above maximum');
        }
        if ('multipleOf' in schema && !isDyadic(schema.multipleOf)) {
          add(path, `multipleOf ${schema.multipleOf} is not exact in binary floating point; use a scaled integer`);
        }
        break;
      }
      case 'object': {
        if (schema.additionalProperties !== false) add(path, 'object without additionalProperties: false');
        const properties = isMap(schema.properties) ? schema.properties : {};
        if ('properties' in schema && !isMap(schema.properties)) add(path, 'properties is not an object');
        for (const name of Array.isArray(schema.required) ? schema.required : []) {
          if (!Object.hasOwn(properties, name)) add(path, `required property ${name} is not defined`);
        }
        for (const [name, deps] of Object.entries(isMap(schema.dependentRequired) ? schema.dependentRequired : {})) {
          for (const dep of [name, ...(Array.isArray(deps) ? deps : [])]) {
            if (!Object.hasOwn(properties, dep)) add(path, `dependentRequired names undefined property ${dep}`);
          }
        }
        break;
      }
      case 'array': {
        if (schema.items === undefined) add(path, 'array without items');
        if (typeof schema.maxItems !== 'number') add(path, 'array without maxItems');
        break;
      }
      default:
        break;
    }
  });
  return problems;
}

function pointerOf(path) {
  if (path.length > 0 && typeof path[0] === 'string' && path[0].startsWith('#/')) {
    return path.length === 1 ? path[0] : `${path[0]}/${path.slice(1).join('/')}`;
  }
  return pointer(path);
}

/** Every `$ref` string anywhere in the document, with where it sits. */
function allRefs(doc) {
  const refs = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((child, i) => walk(child, [...path, i]));
    else if (isMap(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key === '$ref') refs.push({ ref: child, path });
        else walk(child, [...path, key]);
      }
    }
  };
  walk(doc, []);
  return refs;
}

/**
 * A small structural check of OpenAPI 3.1. Not a full validator, but it
 * covers what the generators and the API Gateway rely on: version, info,
 * paths and operations, unique operation ids, path parameters that match the
 * template, responses, JSON-only request bodies, the bearer JWT scheme on
 * every route, local references that resolve, and no unused schema.
 */
export function checkStructure(doc) {
  const problems = [];
  if (!isMap(doc)) return ['document is not an object'];
  const allowedTop = ['openapi', 'info', 'jsonSchemaDialect', 'servers', 'paths', 'components', 'security', 'tags', 'externalDocs', 'webhooks'];
  for (const key of Object.keys(doc)) {
    if (!allowedTop.includes(key) && !key.startsWith('x-')) problems.push(`unknown top-level key ${key}`);
  }
  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) problems.push(`openapi must be 3.1.x, got ${JSON.stringify(doc.openapi)}`);
  if (!isMap(doc.info) || typeof doc.info.title !== 'string' || typeof doc.info.version !== 'string') {
    problems.push('info needs title and version');
  }
  if (doc.jsonSchemaDialect !== undefined && doc.jsonSchemaDialect !== 'https://json-schema.org/draft/2020-12/schema') {
    problems.push('jsonSchemaDialect must be JSON Schema 2020-12');
  }

  // Security: one bearer JWT scheme, required globally, never overridden.
  const scheme = doc.components?.securitySchemes?.bearerAuth;
  if (!isMap(scheme) || scheme.type !== 'http' || scheme.scheme !== 'bearer' || scheme.bearerFormat !== 'JWT') {
    problems.push('components.securitySchemes.bearerAuth must be http bearer with bearerFormat JWT');
  }
  const isBearerOnly = (security) =>
    Array.isArray(security) && security.length === 1 && isMap(security[0]) &&
    Object.keys(security[0]).length === 1 && Array.isArray(security[0].bearerAuth);
  if (!isBearerOnly(doc.security)) problems.push('top-level security must be [{ bearerAuth: [] }]');

  // References.
  for (const { ref, path } of allRefs(doc)) {
    if (resolveRef(doc, ref) === undefined) problems.push(`${pointer(path)}: $ref ${JSON.stringify(ref)} does not resolve`);
  }
  const used = new Set(allRefs(doc).map(({ ref }) => ref));
  for (const name of Object.keys(doc.components?.schemas ?? {})) {
    if (!used.has(SCHEMAS_PREFIX + name)) problems.push(`components.schemas.${name} is never used`);
  }

  if (!isMap(doc.paths) || Object.keys(doc.paths).length === 0) {
    problems.push('paths is empty');
    return problems;
  }
  const operationIds = new Set();
  const deref = (node) => (isMap(node) && typeof node.$ref === 'string' ? resolveRef(doc, node.$ref) : node);

  for (const [route, item] of Object.entries(doc.paths)) {
    if (!/^(\/([a-z][a-z0-9_]*|\{[a-z][a-z0-9_]*\}))+$/.test(route)) {
      problems.push(`path ${route}: must be lowercase segments or {snake_case} parameters, no trailing slash`);
    }
    if (!isMap(item)) {
      problems.push(`path ${route}: not an object`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (![...HTTP_METHODS, 'parameters', 'summary', 'description'].includes(key)) problems.push(`path ${route}: unknown key ${key}`);
    }
    const templateParams = [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const operations = HTTP_METHODS.filter((m) => item[m] !== undefined);
    if (operations.length === 0) problems.push(`path ${route}: no operations`);

    for (const method of operations) {
      const op = item[method];
      const where = `${method.toUpperCase()} ${route}`;
      if (!isMap(op)) {
        problems.push(`${where}: not an object`);
        continue;
      }
      if (typeof op.operationId !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(op.operationId)) {
        problems.push(`${where}: operationId missing or not camelCase`);
      } else if (operationIds.has(op.operationId)) {
        problems.push(`${where}: duplicate operationId ${op.operationId}`);
      } else {
        operationIds.add(op.operationId);
      }
      if ('security' in op && !isBearerOnly(op.security)) problems.push(`${where}: overrides security; every route needs the bearer token`);

      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
      const seen = new Set();
      for (const param of params) {
        if (!isMap(param) || typeof param.name !== 'string' || !['path', 'query', 'header'].includes(param.in) || param.schema === undefined) {
          problems.push(`${where}: parameter needs name, in (path, query or header) and schema`);
          continue;
        }
        const key = `${param.in}:${param.name}`;
        if (seen.has(key)) problems.push(`${where}: duplicate parameter ${param.name}`);
        seen.add(key);
        if (param.in === 'path') {
          if (param.required !== true) problems.push(`${where}: path parameter ${param.name} must be required`);
          if (!templateParams.includes(param.name)) problems.push(`${where}: path parameter ${param.name} is not in the path`);
        }
      }
      for (const name of templateParams) {
        if (!seen.has(`path:${name}`)) problems.push(`${where}: path parameter ${name} is not declared`);
      }

      if (op.requestBody !== undefined) {
        const body = deref(op.requestBody);
        if (!isMap(body) || body.required !== true) problems.push(`${where}: requestBody must be required`);
        const types = Object.keys(isMap(body?.content) ? body.content : {});
        if (types.length !== 1 || types[0] !== JSON_MEDIA_TYPE) problems.push(`${where}: requestBody must be ${JSON_MEDIA_TYPE} only`);
        if (['get', 'delete'].includes(method)) problems.push(`${where}: ${method.toUpperCase()} must not have a body`);
      }

      if (!isMap(op.responses) || Object.keys(op.responses).length === 0) {
        problems.push(`${where}: no responses`);
        continue;
      }
      if (!Object.keys(op.responses).some((code) => /^2\d\d$/.test(code))) problems.push(`${where}: no success response`);
      if (!('401' in op.responses)) problems.push(`${where}: no 401 response`);
      for (const [code, raw] of Object.entries(op.responses)) {
        const response = deref(raw);
        if (!/^[1-5]\d\d$/.test(code)) problems.push(`${where}: response code ${code} is not a status code`);
        if (!isMap(response) || typeof response.description !== 'string') {
          problems.push(`${where} ${code}: response needs a description`);
          continue;
        }
        for (const [mediaType, media] of Object.entries(isMap(response.content) ? response.content : {})) {
          if (![JSON_MEDIA_TYPE, CSV_MEDIA_TYPE].includes(mediaType)) problems.push(`${where} ${code}: media type ${mediaType} is not allowed`);
          if (!isMap(media) || media.schema === undefined) problems.push(`${where} ${code}: ${mediaType} has no schema`);
          if (mediaType === CSV_MEDIA_TYPE && media?.schema?.contentMediaType !== CSV_MEDIA_TYPE) {
            problems.push(`${where} ${code}: a CSV body must be a string with contentMediaType ${CSV_MEDIA_TYPE}`);
          }
        }
        if (code === '204' && response.content !== undefined) problems.push(`${where} 204: must not have content`);
      }
    }
  }
  return problems;
}

/** Property and parameter names that would carry a user id. */
export function findIdentityFields(doc) {
  const problems = [];
  const forbidden = (name) => IDENTITY_NAMES.includes(String(name).toLowerCase().replaceAll('-', '_'));
  forEachSchema(doc, (schema, path) => {
    if (!isMap(schema?.properties)) return;
    for (const name of Object.keys(schema.properties)) {
      if (forbidden(name)) problems.push(`${pointerOf(path)}: property ${name} would let the client name a user`);
    }
  });
  const params = [];
  for (const [name, param] of Object.entries(doc?.components?.parameters ?? {})) params.push([`components.parameters.${name}`, param]);
  for (const [route, item] of Object.entries(doc?.paths ?? {})) {
    for (const param of item?.parameters ?? []) params.push([route, param]);
    for (const method of HTTP_METHODS) for (const param of item?.[method]?.parameters ?? []) params.push([`${method.toUpperCase()} ${route}`, param]);
    for (const segment of route.split('/')) {
      const name = segment.replace(/^\{|\}$/g, '');
      if (forbidden(name)) problems.push(`path ${route}: segment ${segment} would let the client name a user`);
    }
  }
  for (const [where, param] of params) {
    if (isMap(param) && typeof param.name === 'string' && forbidden(param.name)) {
      problems.push(`${where}: parameter ${param.name} would let the client name a user`);
    }
  }
  return problems;
}

/**
 * What the OpenAPI document is checked against: the id lists (union over all
 * published versions, since ids are never reused or removed without an ADR),
 * the files of every published version, the latest published version, and
 * the languages that have an i18n file.
 */
export function loadVocabularyContext() {
  const published = [];
  for (const version of listVersions()) {
    const files = loadVocabulary(version);
    if (Object.values(files).every((file) => file.status === 'published')) published.push({ version, files });
  }
  return {
    lists: mergeIdLists(published.map(({ files }) => collectIds(files).lists)),
    published,
    latestPublished: published.length > 0 ? published[published.length - 1].version : undefined,
    languages: Object.keys(loadI18n()).sort(),
  };
}

function lookupValue(files, dotted) {
  let node = files;
  for (const key of dotted.split('.')) {
    if (!isMap(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** A vocabulary value that must be the same in every published version. */
function valueAcrossVersions(context, dotted) {
  const values = context.published.map(({ files }) => lookupValue(files, dotted));
  if (values.length === 0 || values.some((v) => v === undefined)) return { missing: true };
  const first = JSON.stringify(values[0]);
  return { value: values[0], differs: values.some((v) => JSON.stringify(v) !== first) };
}

const round = (x) => Math.round(x * 1e9) / 1e9;

/**
 * Binds the document to the vocabulary, so the two cannot drift:
 * - every enum carries `x-vocabulary: <namespace>` and equals that list
 *   (ids and order), or `x-i18n-languages` and equals the i18n languages;
 * - `x-vocabulary-range: <file>.<path>` makes the bounds and step equal the
 *   vocabulary range, times `x-vocabulary-scale` for scaled integers;
 * - `x-vocabulary-keys: <namespace>` makes the property names equal a list;
 * - `x-vocabulary-max-items: <file>.<path>` makes maxItems equal a value;
 * - `x-vocabulary-version` is an integer from 1 to the latest published
 *   version;
 * - every request body that holds a vocabulary value has a required
 *   top-level `vocabulary_version`;
 * - every vocabulary range is used by at least one schema;
 * - no other `x-vocabulary*` keyword exists (typo guard).
 */
export function checkVocabularyBindings(doc, context) {
  const problems = [];
  const usedRanges = new Set();

  forEachSchema(doc, (schema, path, walkContext) => {
    if (!isMap(schema) || walkContext.inNot) return;
    const where = pointerOf(path);
    for (const key of Object.keys(schema)) {
      if ((key.startsWith('x-vocabulary') || key.startsWith('x-i18n')) && !VOCABULARY_KEYWORDS.includes(key)) {
        problems.push(`${where}: unknown keyword ${key}`);
      }
    }

    if ('enum' in schema) {
      if (schema['x-vocabulary'] !== undefined) {
        const expected = context.lists[schema['x-vocabulary']];
        if (!expected) problems.push(`${where}: x-vocabulary ${schema['x-vocabulary']} is not a vocabulary list`);
        else if (JSON.stringify(schema.enum) !== JSON.stringify(expected)) {
          const missing = expected.filter((id) => !schema.enum.includes(id));
          const extra = (schema.enum ?? []).filter((id) => !expected.includes(id));
          problems.push(`${where}: enum differs from vocabulary ${schema['x-vocabulary']}` +
            (missing.length ? `; missing ${missing.join(', ')}` : '') +
            (extra.length ? `; not in vocabulary ${extra.join(', ')}` : '') +
            (!missing.length && !extra.length ? '; order differs' : ''));
        }
      } else if (schema['x-i18n-languages'] === true) {
        if (JSON.stringify([...(schema.enum ?? [])].sort()) !== JSON.stringify(context.languages)) {
          problems.push(`${where}: enum differs from the i18n languages ${context.languages.join(', ')}`);
        }
      } else {
        problems.push(`${where}: enum without x-vocabulary; every enum must be drawn from the vocabulary`);
      }
    } else if (schema['x-vocabulary'] !== undefined || schema['x-i18n-languages'] !== undefined) {
      problems.push(`${where}: x-vocabulary or x-i18n-languages without enum`);
    }

    if (schema['x-vocabulary-range'] !== undefined) {
      const name = schema['x-vocabulary-range'];
      usedRanges.add(name);
      const { value: range, missing, differs } = valueAcrossVersions(context, name);
      const scale = schema['x-vocabulary-scale'] ?? 1;
      if (missing || !isMap(range) || typeof range.multipleOf !== 'number') {
        problems.push(`${where}: x-vocabulary-range ${name} is not a range in every published version`);
      } else if (differs) {
        problems.push(`${where}: range ${name} differs between published versions; the API needs a decision`);
      } else if (!Number.isInteger(scale) || scale < 1) {
        problems.push(`${where}: x-vocabulary-scale must be a positive integer`);
      } else {
        const min = round(range.minimum * scale);
        const max = round(range.maximum * scale);
        const step = round(range.multipleOf * scale);
        if (schema.minimum !== min || schema.maximum !== max) {
          problems.push(`${where}: bounds ${schema.minimum}..${schema.maximum} differ from vocabulary ${name} ${min}..${max}` +
            (scale !== 1 ? ` (scaled by ${scale})` : ''));
        }
        if (Number.isInteger(step)) {
          if (schema.type !== 'integer') problems.push(`${where}: step ${step} is whole, so type must be integer`);
          const actual = schema.multipleOf ?? 1;
          if (actual !== step) problems.push(`${where}: multipleOf ${actual} differs from vocabulary step ${step}`);
        } else {
          if (schema.type !== 'number') problems.push(`${where}: step ${step} is fractional, so type must be number`);
          if (schema.multipleOf !== step) problems.push(`${where}: multipleOf ${schema.multipleOf} differs from vocabulary step ${step}`);
        }
      }
    } else if (schema['x-vocabulary-scale'] !== undefined) {
      problems.push(`${where}: x-vocabulary-scale without x-vocabulary-range`);
    }

    if (schema['x-vocabulary-keys'] !== undefined) {
      const expected = context.lists[schema['x-vocabulary-keys']];
      const actual = Object.keys(isMap(schema.properties) ? schema.properties : {});
      if (!expected) problems.push(`${where}: x-vocabulary-keys ${schema['x-vocabulary-keys']} is not a vocabulary list`);
      else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        problems.push(`${where}: properties ${actual.join(', ')} differ from vocabulary ${schema['x-vocabulary-keys']}`);
      }
    }

    if (schema['x-vocabulary-max-items'] !== undefined) {
      const { value, missing, differs } = valueAcrossVersions(context, schema['x-vocabulary-max-items']);
      if (missing || typeof value !== 'number') problems.push(`${where}: x-vocabulary-max-items ${schema['x-vocabulary-max-items']} is not a number in the vocabulary`);
      else if (differs) problems.push(`${where}: ${schema['x-vocabulary-max-items']} differs between published versions`);
      else if (schema.maxItems !== value) problems.push(`${where}: maxItems ${schema.maxItems} differs from vocabulary ${schema['x-vocabulary-max-items']} ${value}`);
    }

    if (schema['x-vocabulary-version'] !== undefined) {
      if (schema['x-vocabulary-version'] !== true) problems.push(`${where}: x-vocabulary-version must be true`);
      if (schema.type !== 'integer' || schema.minimum !== 1 || schema.maximum !== context.latestPublished) {
        problems.push(`${where}: vocabulary version must be an integer from 1 to the latest published version ${context.latestPublished}`);
      }
    }
  });

  // Every range is used somewhere.
  for (const { files } of context.published.slice(-1)) {
    const names = [
      ...Object.keys(files.brew?.ranges ?? {}).map((name) => `brew.ranges.${name}`),
      ...(files.criteria?.scale ? ['criteria.scale'] : []),
    ];
    for (const name of names) if (!usedRanges.has(name)) problems.push(`vocabulary range ${name} is not used by any schema`);
  }

  // Every request body that carries vocabulary values carries the version.
  const deref = (node) => (isMap(node) && typeof node.$ref === 'string' ? resolveRef(doc, node.$ref) : node);
  for (const [route, item] of Object.entries(doc?.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const schema = deref(deref(item?.[method]?.requestBody)?.content?.[JSON_MEDIA_TYPE]?.schema);
      if (!isMap(schema)) continue;
      if (!usesVocabulary(doc, schema)) continue;
      const version = deref(schema.properties?.vocabulary_version);
      if (!isMap(version) || version['x-vocabulary-version'] !== true || !(schema.required ?? []).includes('vocabulary_version')) {
        problems.push(`${method.toUpperCase()} ${route}: request carries vocabulary values but no required vocabulary_version`);
      }
    }
  }
  return problems;
}

function usesVocabulary(doc, root) {
  const seen = new Set();
  const walk = (schema) => {
    if (!isMap(schema)) return false;
    if (typeof schema.$ref === 'string') {
      if (seen.has(schema.$ref)) return false;
      seen.add(schema.$ref);
      return walk(resolveRef(doc, schema.$ref));
    }
    if (['x-vocabulary', 'x-vocabulary-range', 'x-vocabulary-keys', 'x-vocabulary-max-items'].some((k) => k in schema)) return true;
    const children = [
      ...Object.values(isMap(schema.properties) ? schema.properties : {}),
      ...(schema.items ? [schema.items] : []),
      ...['oneOf', 'anyOf'].flatMap((k) => (Array.isArray(schema[k]) ? schema[k] : [])),
    ];
    return children.some(walk);
  };
  return walk(root);
}

/**
 * Compiles the component schemas with ajv (JSON Schema 2020-12, strict mode,
 * so a misspelt keyword fails) and returns `validate(name, value)`, which
 * returns ajv's errors or an empty list. Tests use it to show the schemas
 * accept and reject what the specification says. The date formats here are
 * simple regular expressions; generators use proper format validators.
 */
export function compileComponentSchemas(doc) {
  // strictRequired is off because `not: { required: [...] }` (two fields
  // that exclude each other) names properties outside its own subschema.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  for (const keyword of VOCABULARY_KEYWORDS) ajv.addKeyword(keyword);
  ajv.addFormat('date', /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  ajv.addFormat('date-time', /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/);
  const schemas = JSON.parse(JSON.stringify(doc.components?.schemas ?? {}).replaceAll(`"${SCHEMAS_PREFIX}`, '"#/$defs/'));
  const id = 'https://cupmark.invalid/openapi';
  ajv.addSchema({ $id: id, $defs: schemas });
  // Compile every component now, so a bad keyword throws here and not on
  // first use.
  const compiled = {};
  for (const name of Object.keys(schemas)) compiled[name] = ajv.getSchema(`${id}#/$defs/${name}`);
  return (name, value) => {
    const validate = compiled[name];
    if (!validate) throw new Error(`no component schema ${name}`);
    return validate(value) ? [] : validate.errors;
  };
}

/** All checks together, as used by bin/lint-openapi.mjs. */
export function checkOpenApi(doc, context) {
  const problems = [...checkStructure(doc), ...lintSchemas(doc), ...findIdentityFields(doc), ...checkVocabularyBindings(doc, context)];
  try {
    compileComponentSchemas(doc);
  } catch (error) {
    problems.push(`schemas do not compile as JSON Schema 2020-12: ${error.message}`);
  }
  return problems;
}

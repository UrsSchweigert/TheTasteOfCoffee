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
const JPEG_MEDIA_TYPE = 'image/jpeg';
/**
 * Response bodies that are not JSON: the CSV export and the stored copy of a
 * catalogue image (ADR 0011). Each must be exactly
 * `{ type: string, contentMediaType: <the media type> }`, and only in a
 * response; request bodies are JSON only.
 */
export const RAW_RESPONSE_MEDIA_TYPES = [CSV_MEDIA_TYPE, JPEG_MEDIA_TYPE];
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
 * The two documented exceptions to "no free text" and "bearer token on every
 * route". Both are listed here and nowhere else; see README.md, "Exceptions".
 *
 * 1. Response-only free text from Open Food Facts (ADR 0005). A string without
 *    enum, pattern or format is allowed only with `x-free-text-from: <source>`
 *    naming one of FREE_TEXT_SOURCES, `readOnly: true` and a `maxLength` of 1
 *    to FREE_TEXT_MAX_LENGTH, and only where no request body or parameter can
 *    reach it, through any number of `$ref`s.
 * 2. The health route (ADR 0007). Exactly the operations in
 *    UNAUTHENTICATED_ROUTES declare `security: []`; they take no parameters
 *    and no body, their path has no other operation, and they return the
 *    schema named there. That schema is exactly
 *    `{ type: object, additionalProperties: false, required: [status],
 *    properties: { status } }`, and `status` is a string enum tagged
 *    `x-health-status: true` holding only HEALTH_STATUS_VALUES.
 */
export const FREE_TEXT_KEYWORD = 'x-free-text-from';
export const FREE_TEXT_SOURCES = ['open_food_facts'];
export const FREE_TEXT_MAX_LENGTH = 200;
export const HEALTH_STATUS_KEYWORD = 'x-health-status';
export const HEALTH_STATUS_VALUES = ['ok'];
/** The one property of the health body. */
export const HEALTH_STATUS_PROPERTY = 'status';
export const UNAUTHENTICATED_ROUTES = [
  { method: 'get', route: '/health', schema: 'HealthStatus', decision: 'docs/decisions/0007-unauthenticated-health-route.md' },
];

/** Every extension keyword a schema may carry. */
export const EXTENSION_KEYWORDS = [...VOCABULARY_KEYWORDS, FREE_TEXT_KEYWORD, HEALTH_STATUS_KEYWORD];

/**
 * Lists of the vocabulary that no API schema binds, with the reason. Every
 * other list of the latest published version must be bound by an
 * `x-vocabulary` enum or `x-vocabulary-keys`, so publishing a version with a
 * new list fails until the API carries it.
 */
export const UNBOUND_LISTS = {
  flavour_categories: 'groups the flavour notes for display; the API carries the notes only',
};

/**
 * Names that would let a client say who the user is. The user id comes from
 * the token only (CLAUDE.md, invariant 3). A name is normalised to
 * snake_case (camelCase split, `-` and `.` as `_`) and fails if it equals one
 * of IDENTITY_NAMES or contains one of IDENTITY_TOKENS as a whole token, so
 * `cognito_sub` and `ownerId` fail but `subscription` does not.
 */
export const IDENTITY_NAMES = [
  'userid', 'ownerid', 'subject', 'account_id', 'cognito_id', 'apple_id', 'identity_id',
];
export const IDENTITY_TOKENS = ['user', 'users', 'owner', 'owners', 'sub', 'uid'];

/** `ownerId` -> `owner_id`, `userID` -> `user_id`, `cognito-sub` -> `cognito_sub`. */
export function toSnakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-.\s]+/g, '_');
}

/** True if the name would let a client name a user. */
export function isIdentityName(name) {
  const snake = toSnakeCase(name);
  if (IDENTITY_NAMES.includes(snake)) return true;
  return snake.split('_').some((token) => IDENTITY_TOKENS.includes(token));
}

/**
 * Keywords a schema may use. Anything else fails, so no keyword can carry an
 * unchecked subschema (prefixItems, contains, if/then/else,
 * dependentSchemas, propertyNames, unevaluated*) or a loose shape
 * (patternProperties, allOf, const, exclusive bounds).
 */
export const SCHEMA_KEYWORDS = [
  '$ref', 'description', 'title', 'default', 'readOnly',
  'type', 'enum', 'pattern', 'format', 'contentMediaType', 'minLength', 'maxLength',
  'minimum', 'maximum', 'multipleOf',
  'properties', 'required', 'additionalProperties', 'dependentRequired',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'oneOf', 'anyOf', 'not',
  ...EXTENSION_KEYWORDS,
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
const WIDE_ESCAPES = ['S', 's', 'W', 'w', 'D', 'P', 'p'];

/**
 * Problems with a string pattern beyond anchoring. A pattern must name its
 * characters and its length: no `.`, no wide escape (`\S`, `\s`, `\w`,
 * `\W`, `\D`, `\p{...}`, `\P{...}`), no negated class `[^...]`, and no
 * unbounded quantifier (`*`, `+`, `{n,}`). It must also compile.
 */
export function patternProblems(pattern) {
  const problems = [];
  try {
    new RegExp(pattern, 'u');
  } catch {
    return [`pattern ${pattern} is not a valid regular expression`];
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      const next = pattern[i + 1];
      if (WIDE_ESCAPES.includes(next)) problems.push(`pattern ${pattern} uses the wide class \\${next}`);
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      if (pattern[i + 1] === '^') problems.push(`pattern ${pattern} uses a negated class [^...]`);
      continue;
    }
    if (char === '.') problems.push(`pattern ${pattern} uses the wide class .`);
    if (char === '*' || char === '+') problems.push(`pattern ${pattern} has the unbounded quantifier ${char}`);
    if (char === '{' && /^\{\d+,\}/.test(pattern.slice(i))) problems.push(`pattern ${pattern} has an unbounded quantifier {n,}`);
  }
  return problems;
}

/**
 * The no-free-text lint. Fails on:
 * - a string without `enum`, an anchored `pattern` or a `format` of date or
 *   date-time. Exceptions: a CSV or JPEG response body whose
 *   `contentMediaType` is its media type, and response-only free text marked `x-free-text-from` with
 *   `readOnly: true` and a bounded `maxLength` (findRequestFreeText proves no
 *   request reaches it);
 * - `x-free-text-from` on anything but a string, and `readOnly` without it;
 * - a number or integer without numeric `minimum` and `maximum`, or with a
 *   `multipleOf` that is not exact in binary floating point (0.1 is not,
 *   0.5 is; send such values as scaled integers);
 * - an object without `additionalProperties: false`, or with `required`
 *   names it does not define;
 * - an array without `items` or `maxItems`;
 * - a schema without a single `type` (unless it is a `$ref` or `oneOf` /
 *   `anyOf`), `allOf` (it defeats additionalProperties: false), a `$ref`
 *   that does not resolve or is not local, `patternProperties`, and a `not`
 *   that is anything but `{ required: [...] }`;
 * - any keyword not in SCHEMA_KEYWORDS;
 * - a pattern that is wide or unbounded (see patternProblems).
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
    for (const key of Object.keys(schema)) {
      if (key === 'allOf') add(path, 'allOf is not allowed (it defeats additionalProperties: false); nest objects instead');
      else if (!SCHEMA_KEYWORDS.includes(key)) add(path, `keyword ${key} is not allowed`);
    }
    if ('$ref' in schema) {
      if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) add(path, `$ref ${JSON.stringify(schema.$ref)} is not local`);
      else if (resolveRef(doc, schema.$ref) === undefined) add(path, `$ref ${schema.$ref} does not resolve`);
      const extra = Object.keys(schema).filter((k) => !['$ref', 'description'].includes(k));
      if (extra.length > 0) add(path, `$ref has sibling keywords ${extra.join(', ')}`);
      return;
    }
    if (FREE_TEXT_KEYWORD in schema && schema.type !== 'string') add(path, `${FREE_TEXT_KEYWORD} is only allowed on a string`);
    if ('readOnly' in schema && !(FREE_TEXT_KEYWORD in schema)) add(path, `readOnly is only used on response-only free text (${FREE_TEXT_KEYWORD})`);
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
        if (hasPattern) for (const problem of patternProblems(schema.pattern)) add(path, problem);
        const hasFormat = typeof schema.format === 'string';
        if (hasFormat && !STRING_FORMATS.includes(schema.format)) {
          add(path, `format ${schema.format} is not one of ${STRING_FORMATS.join(', ')}`);
        }
        const isRawBody = RAW_RESPONSE_MEDIA_TYPES.includes(context.mediaType) && schema.contentMediaType === context.mediaType;
        const isFreeText = FREE_TEXT_KEYWORD in schema;
        if (isFreeText) {
          const source = schema[FREE_TEXT_KEYWORD];
          if (!FREE_TEXT_SOURCES.includes(source)) {
            add(path, `${FREE_TEXT_KEYWORD} ${JSON.stringify(source)} is not one of ${FREE_TEXT_SOURCES.join(', ')}`);
          }
          if (hasEnum || hasPattern || hasFormat || 'contentMediaType' in schema) {
            add(path, `${FREE_TEXT_KEYWORD} is only for a string without enum, pattern, format or contentMediaType`);
          }
          if (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > FREE_TEXT_MAX_LENGTH) {
            add(path, `free text needs a maxLength from 1 to ${FREE_TEXT_MAX_LENGTH}`);
          }
          if ('minLength' in schema && (!Number.isInteger(schema.minLength) || schema.minLength < 0 || schema.minLength > schema.maxLength)) {
            add(path, 'free text minLength must be an integer from 0 to maxLength');
          }
          if (schema.readOnly !== true) add(path, 'free text needs readOnly: true (it is response-only)');
        }
        if (!hasEnum && !hasPattern && !hasFormat && !isRawBody && !isFreeText) add(path, 'string without enum, pattern or format');
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

/**
 * Response-only free text must stay response-only. Walks everything a client
 * sends (every request body and parameter of every operation and webhook,
 * their callbacks, and components.requestBodies and components.parameters
 * even when unused), follows every `$ref` to its target, and reports each
 * schema with `x-free-text-from` it reaches. The walk visits every nested
 * value, not only the keywords the lint allows, so no keyword can hide one.
 */
export function findRequestFreeText(doc) {
  const problems = new Set();
  const walkFrom = (start, path, label) => {
    const seen = new Set();
    const walk = (node, where) => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, [...where, i]));
        return;
      }
      if (!isMap(node)) return;
      if (FREE_TEXT_KEYWORD in node) {
        problems.add(`${pointerOf(where)}: free text from ${node[FREE_TEXT_KEYWORD]} is reachable from ${label}; it is allowed in responses only`);
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === '$ref' && typeof child === 'string') {
          if (seen.has(child)) continue;
          seen.add(child);
          const target = resolveRef(doc, child);
          if (target !== undefined) walk(target, [child]);
          continue;
        }
        walk(child, [...where, key]);
      }
    };
    walk(start, path);
  };

  for (const top of ['paths', 'webhooks']) {
    for (const [route, item] of Object.entries(isMap(doc?.[top]) ? doc[top] : {})) {
      if (!isMap(item)) continue;
      if (item.parameters !== undefined) walkFrom(item.parameters, [top, route, 'parameters'], `${route} parameters`);
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!isMap(op)) continue;
        const where = `${method.toUpperCase()} ${route}`;
        for (const key of ['requestBody', 'parameters', 'callbacks']) {
          const label = key === 'requestBody' ? `the ${where} request body` : `${where} ${key}`;
          if (op[key] !== undefined) walkFrom(op[key], [top, route, method, key], label);
        }
      }
    }
  }
  for (const kind of ['requestBodies', 'parameters', 'callbacks']) {
    for (const [name, value] of Object.entries(isMap(doc?.components?.[kind]) ? doc.components[kind] : {})) {
      walkFrom(value, ['components', kind, name], `components.${kind}.${name}`);
    }
  }
  return [...problems];
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

  for (const open of UNAUTHENTICATED_ROUTES) {
    const ref = SCHEMAS_PREFIX + open.schema;
    const expected = ['paths', open.route, open.method, 'responses', '200', 'content', JSON_MEDIA_TYPE, 'schema'];
    for (const { ref: found, path } of allRefs(doc)) {
      if (found === ref && JSON.stringify(path) !== JSON.stringify(expected)) {
        problems.push(`${pointer(path)}: ${ref} is the body of ${open.method.toUpperCase()} ${open.route} and may not be used anywhere else`);
      }
    }
  }

  for (const open of UNAUTHENTICATED_ROUTES) problems.push(...healthSchemaProblems(doc.components?.schemas?.[open.schema], open.schema));

  if (!isMap(doc.paths) || Object.keys(doc.paths).length === 0) {
    problems.push('paths is empty');
    return problems;
  }
  for (const open of UNAUTHENTICATED_ROUTES) {
    if (!isMap(doc.paths[open.route]?.[open.method])) problems.push(`${open.method.toUpperCase()} ${open.route}: missing (${open.decision})`);
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
      const open = UNAUTHENTICATED_ROUTES.find((r) => r.method === method && r.route === route);
      const sharesOpenPath = UNAUTHENTICATED_ROUTES.find((r) => r.route === route && r.method !== method);
      if (!open && sharesOpenPath) {
        problems.push(`${where}: ${route} has ${sharesOpenPath.method.toUpperCase()} only (${sharesOpenPath.decision})`);
      }
      if (open) {
        if (!Array.isArray(op.security) || op.security.length !== 0) {
          problems.push(`${where}: must declare security: [] (${open.decision})`);
        }
        if (op.requestBody !== undefined) problems.push(`${where}: the unauthenticated route takes no request body`);
        if ((item.parameters ?? []).length > 0 || (op.parameters ?? []).length > 0) {
          problems.push(`${where}: the unauthenticated route takes no parameters`);
        }
        const codes = Object.keys(isMap(op.responses) ? op.responses : {});
        if (JSON.stringify(codes.sort()) !== JSON.stringify(['200', '429'])) {
          problems.push(`${where}: the unauthenticated route returns 200 and 429 only, got ${codes.join(', ')}`);
        }
        const ok = deref(op.responses?.['200']);
        const body = isMap(ok?.content) ? ok.content : {};
        if (Object.keys(body).join() !== JSON_MEDIA_TYPE || body[JSON_MEDIA_TYPE]?.schema?.$ref !== SCHEMAS_PREFIX + open.schema) {
          problems.push(`${where}: 200 must return ${JSON_MEDIA_TYPE} with $ref ${SCHEMAS_PREFIX}${open.schema}`);
        }
      } else if ('security' in op && !isBearerOnly(op.security)) {
        problems.push(`${where}: overrides security; every route needs the bearer token (the only exceptions are ${UNAUTHENTICATED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.route}`).join(', ')})`);
      }

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
      if (!open && !('401' in op.responses)) problems.push(`${where}: no 401 response`);
      for (const [code, raw] of Object.entries(op.responses)) {
        const response = deref(raw);
        if (!/^[1-5]\d\d$/.test(code)) problems.push(`${where}: response code ${code} is not a status code`);
        if (!isMap(response) || typeof response.description !== 'string') {
          problems.push(`${where} ${code}: response needs a description`);
          continue;
        }
        for (const [mediaType, media] of Object.entries(isMap(response.content) ? response.content : {})) {
          if (![JSON_MEDIA_TYPE, ...RAW_RESPONSE_MEDIA_TYPES].includes(mediaType)) problems.push(`${where} ${code}: media type ${mediaType} is not allowed`);
          if (!isMap(media) || media.schema === undefined) problems.push(`${where} ${code}: ${mediaType} has no schema`);
          const raw = media?.schema;
          const isExactRaw = isMap(raw) && Object.keys(raw).sort().join() === 'contentMediaType,type' && raw.type === 'string' && raw.contentMediaType === mediaType;
          if (RAW_RESPONSE_MEDIA_TYPES.includes(mediaType) && !isExactRaw) {
            problems.push(`${where} ${code}: a ${mediaType} body must be exactly { type: string, contentMediaType: ${mediaType} }`);
          }
        }
        if (code === '204' && response.content !== undefined) problems.push(`${where} 204: must not have content`);
      }
    }
  }
  return problems;
}

/**
 * The body of the unauthenticated route must be exactly
 * `{ type: object, additionalProperties: false, required: [status],
 * properties: { status: { type: string, enum: [ok], x-health-status: true } } }`
 * (a `description` is allowed on both), so it can never grow a field that
 * leaks data without the token.
 */
function healthSchemaProblems(schema, name) {
  const where = `components.schemas.${name}`;
  if (!isMap(schema)) return [`${where}: missing`];
  const problems = [];
  const keysOf = (node) => Object.keys(node).filter((key) => key !== 'description').sort().join();
  if (keysOf(schema) !== 'additionalProperties,properties,required,type') {
    problems.push(`${where}: must hold exactly type, additionalProperties, required and properties`);
  }
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    problems.push(`${where}: must be an object with additionalProperties: false`);
  }
  if (JSON.stringify(schema.required) !== JSON.stringify([HEALTH_STATUS_PROPERTY])) {
    problems.push(`${where}: required must be exactly [${HEALTH_STATUS_PROPERTY}]`);
  }
  const properties = isMap(schema.properties) ? schema.properties : {};
  if (Object.keys(properties).join() !== HEALTH_STATUS_PROPERTY) {
    problems.push(`${where}: must have exactly one property, ${HEALTH_STATUS_PROPERTY}`);
  }
  const status = properties[HEALTH_STATUS_PROPERTY];
  if (!isMap(status) || keysOf(status) !== `enum,type,${HEALTH_STATUS_KEYWORD}` || status.type !== 'string' ||
      JSON.stringify(status.enum) !== JSON.stringify(HEALTH_STATUS_VALUES) || status[HEALTH_STATUS_KEYWORD] !== true) {
    problems.push(`${where}.properties.${HEALTH_STATUS_PROPERTY}: must be exactly { type: string, enum: [${HEALTH_STATUS_VALUES.join(', ')}], ${HEALTH_STATUS_KEYWORD}: true }`);
  }
  return problems;
}

/** Property and parameter names that would carry a user id. */
export function findIdentityFields(doc) {
  const problems = [];
  const forbidden = isIdentityName;
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
 * What the OpenAPI document is checked against, built from every version
 * `[{ version, files }]` and the i18n languages:
 * - `lists`: the id lists, the union over all published versions (ids are
 *   never reused or removed without an ADR);
 * - `published`: the files of every published version, ascending;
 * - `latestPublished`: the latest version whose files are all published;
 * - `draftLists`: `{ <namespace>: version }` for lists that exist only in a
 *   draft version. The API cannot bind them yet; the check says so by name.
 * A draft version never feeds an enum: its ids may still change, and no
 * request can name it in `vocabulary_version`.
 */
export function buildVocabularyContext(versions, languages) {
  const published = versions.filter(({ files }) => Object.values(files).every((file) => file.status === 'published'));
  const lists = mergeIdLists(published.map(({ files }) => collectIds(files).lists));
  const draftLists = {};
  for (const { version, files } of versions) {
    if (published.some((p) => p.version === version)) continue;
    for (const namespace of Object.keys(collectIds(files).lists)) {
      if (!(namespace in lists) && !(namespace in draftLists)) draftLists[namespace] = version;
    }
  }
  return {
    lists,
    published,
    latestPublished: published.length > 0 ? published[published.length - 1].version : undefined,
    draftLists,
    languages: [...languages].sort(),
  };
}

/** The context for the files on disk. */
export function loadVocabularyContext() {
  const versions = listVersions().map((version) => ({ version, files: loadVocabulary(version) }));
  return buildVocabularyContext(versions, Object.keys(loadI18n()));
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
  const boundLists = new Set();

  forEachSchema(doc, (schema, path, walkContext) => {
    if (!isMap(schema) || walkContext.inNot) return;
    const where = pointerOf(path);
    for (const key of Object.keys(schema)) {
      if ((key.startsWith('x-vocabulary') || key.startsWith('x-i18n')) && !VOCABULARY_KEYWORDS.includes(key)) {
        problems.push(`${where}: unknown keyword ${key}`);
      }
    }

    if (schema[HEALTH_STATUS_KEYWORD] !== undefined) {
      const allowed = UNAUTHENTICATED_ROUTES.map((r) => `${SCHEMAS_PREFIX}${r.schema}/properties/status`);
      if (schema[HEALTH_STATUS_KEYWORD] !== true) problems.push(`${where}: ${HEALTH_STATUS_KEYWORD} must be true`);
      if (!allowed.includes(where)) problems.push(`${where}: ${HEALTH_STATUS_KEYWORD} is only allowed on ${allowed.join(', ')}`);
      if (JSON.stringify(schema.enum) !== JSON.stringify(HEALTH_STATUS_VALUES)) {
        problems.push(`${where}: the health status enum must be exactly [${HEALTH_STATUS_VALUES.join(', ')}]`);
      }
      if (schema['x-vocabulary'] !== undefined || schema['x-i18n-languages'] !== undefined) {
        problems.push(`${where}: ${HEALTH_STATUS_KEYWORD} together with x-vocabulary or x-i18n-languages`);
      }
    } else if ('enum' in schema) {
      if (schema['x-vocabulary'] !== undefined) {
        const expected = context.lists[schema['x-vocabulary']];
        boundLists.add(schema['x-vocabulary']);
        const draft = context.draftLists?.[schema['x-vocabulary']];
        if (!expected && draft !== undefined) {
          problems.push(`${where}: x-vocabulary ${schema['x-vocabulary']} is only in draft vocabulary v${draft}; bind it when v${draft} is published`);
        } else if (!expected) problems.push(`${where}: x-vocabulary ${schema['x-vocabulary']} is not a vocabulary list`);
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
      boundLists.add(schema['x-vocabulary-keys']);
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
    // Every list is bound, so a newly published list cannot be forgotten.
    for (const namespace of Object.keys(collectIds(files).lists)) {
      if (!boundLists.has(namespace) && !(namespace in UNBOUND_LISTS)) {
        problems.push(`vocabulary list ${namespace} is not used by any schema (bind it with x-vocabulary or x-vocabulary-keys)`);
      }
    }
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
  for (const keyword of EXTENSION_KEYWORDS) ajv.addKeyword(keyword);
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
  const problems = [
    ...checkStructure(doc),
    ...lintSchemas(doc),
    ...findRequestFreeText(doc),
    ...findIdentityFields(doc),
    ...checkVocabularyBindings(doc, context),
  ];
  try {
    compileComponentSchemas(doc);
  } catch (error) {
    problems.push(`schemas do not compile as JSON Schema 2020-12: ${error.message}`);
  }
  return problems;
}

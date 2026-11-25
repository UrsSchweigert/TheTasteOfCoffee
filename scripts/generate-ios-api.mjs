#!/usr/bin/env node
// Generates ios/Cupmark/Generated/API.swift from contracts/openapi.yaml
// (backlog M2-T7, ADR 0022): Codable request and response types for every
// operation the app calls, typed with the generated Vocabulary.* enums, so no
// list exists twice. Runs on Linux like the vocabulary generator; it needs no
// Swift package.
//
// With --check it writes nothing and exits 1 if the committed file differs
// from a fresh generation.
//
// What the generator maps, and what it refuses (it throws, so a new shape in
// the contract fails here instead of being dropped):
// - an object component becomes a struct conforming to APIObject, with
//   explicit snake_case CodingKeys and a memberwise init;
// - an `x-vocabulary` enum becomes the Vocabulary type of that list, and
//   `x-i18n-languages` becomes VocabularyLanguage; the enum's ids must equal
//   the bundled vocabulary's ids;
// - other scalar components become typealiases (`API.DoseDg = Int`);
// - CalendarDate (format date) and Timestamp (format date-time) become
//   support structs written below;
// - `x-vocabulary-scale` adds a helper in the unit of the vocabulary range
//   (`doseGrams` for `dose_dg`);
// - `x-vocabulary-keys` adds a subscript by the list's Vocabulary type;
// - properties that exclude each other (`not: { required: [...] }`) become one
//   Swift enum, listed in EXCLUSIVE_GROUPS;
// - an array of objects decodes each element on its own: an element that
//   fails (for example an id the bundled vocabulary does not know) is left
//   out and recorded in `undecodableItems`, so one item never fails a page.
//
// Usage: node scripts/generate-ios-api.mjs [--check] [--file=<path>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApi, resolveRef } from '../contracts/lib/openapi.mjs';
import { loadVocabulary } from '../contracts/lib/vocabulary.mjs';
import {
  describeVocabulary,
  latestPublishedVersion,
  lowerCamel,
  singular,
  swiftCase,
  swiftMember,
  swiftString,
  upperCamel,
} from './generate-ios-vocabulary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_FILE = join(root, 'ios', 'Cupmark', 'Generated', 'API.swift');

/**
 * Operations the app never calls, with the reason. Every other operation of
 * the contract gets its types; an entry naming no operation fails.
 */
export const EXCLUDED_OPERATIONS = {
  getHealth: 'the deploy smoke test calls it (ADR 0007); the app does not',
};

/**
 * Properties that exclude each other (`not: { required: [a, b] }` on the
 * schema) become one optional Swift enum, so both can never be set. Every
 * `not` in a generated schema must be listed here, and every entry must match
 * a `not` of the contract.
 */
export const EXCLUSIVE_GROUPS = [
  {
    schema: 'BrewParameters',
    property: 'water_temperature',
    type: 'WaterTemperature',
    cases: { water_temp_c: 'celsius', water_temp_special: 'special' },
  },
];

/** The components that become hand-written support structs, by their format. */
export const DATE_COMPONENTS = { date: 'CalendarDate', 'date-time': 'Timestamp' };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const JSON_MEDIA_TYPE = 'application/json';
const RAW_MEDIA_TYPES = ['image/jpeg', 'text/csv'];
const SCHEMAS_PREFIX = '#/components/schemas/';
const PARAMETERS_PREFIX = '#/components/parameters/';

/** Keywords that only constrain values. The server checks them; the Swift types do not carry them. */
const CONSTRAINT_KEYWORDS = new Set([
  'description', 'title', 'default', 'readOnly', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'dependentRequired',
  'x-vocabulary-range', 'x-vocabulary-max-items', 'x-vocabulary-version', 'x-free-text-from',
]);
/** Keywords the generator maps to Swift. */
const MAPPED_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'format', 'properties', 'required', 'additionalProperties', 'items', 'not',
  'x-vocabulary', 'x-vocabulary-scale', 'x-vocabulary-keys', 'x-i18n-languages',
]);

/** Type names the generated file declares inside `enum API` itself. */
const SUPPORT_TYPES = new Set([
  'HTTPMethod', 'Endpoint', 'Schemas', 'UndecodableItem', 'DecodingAttempt',
  ...Object.values(DATE_COMPONENTS),
]);
/** Members every generated struct has; no property may take these names. */
const STRUCT_MEMBERS = new Set(['schemaName', 'propertyNames', 'undecodableItems']);
const UNDECODABLE_PROPERTY = 'undecodableItems';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refName = (ref, prefix = SCHEMAS_PREFIX) => {
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(prefix.length);
};

function checkKeywords(schema, where) {
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !MAPPED_KEYWORDS.has(key)) {
      throw new Error(`${where}: keyword ${key} is not supported by generate-ios-api.mjs`);
    }
  }
}

/**
 * The operations the app calls, in document order, with their request and
 * success-response bodies: `{ operationId, method, path, summary,
 * successStatus, requestSchema, responseSchema, responseContentType,
 * parameterSchemas }`. Excluded operations are left out.
 */
export function describeOperations(doc, excluded = EXCLUDED_OPERATIONS) {
  const operations = [];
  const seen = new Set();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      const id = op.operationId;
      if (typeof id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(id)) throw new Error(`${method} ${path}: operationId must be lowerCamelCase`);
      seen.add(id);
      if (Object.hasOwn(excluded, id)) continue;
      const where = `${id} (${method.toUpperCase()} ${path})`;

      let requestSchema = null;
      if (op.requestBody !== undefined) {
        const types = Object.keys(op.requestBody.content ?? {});
        if (types.length !== 1 || types[0] !== JSON_MEDIA_TYPE) throw new Error(`${where}: request body must be ${JSON_MEDIA_TYPE} only`);
        requestSchema = refName(op.requestBody.content[JSON_MEDIA_TYPE].schema?.$ref);
      }

      const success = Object.entries(op.responses ?? {}).filter(([code]) => /^2[0-9][0-9]$/.test(code));
      if (success.length !== 1) throw new Error(`${where}: needs exactly one 2xx response, has ${success.length}`);
      const [code, response] = success[0];
      if (response.$ref !== undefined) throw new Error(`${where}: a referenced 2xx response is not supported`);
      const contentTypes = Object.keys(response.content ?? {});
      if (contentTypes.length > 1) throw new Error(`${where}: the 2xx response has more than one media type`);
      let responseSchema = null;
      let responseContentType = null;
      if (contentTypes.length === 1) {
        responseContentType = contentTypes[0];
        const schema = response.content[responseContentType].schema;
        if (responseContentType === JSON_MEDIA_TYPE) {
          responseSchema = refName(schema?.$ref);
        } else if (RAW_MEDIA_TYPES.includes(responseContentType)) {
          if (schema?.type !== 'string' || schema?.contentMediaType !== responseContentType) {
            throw new Error(`${where}: a ${responseContentType} body must be a string with that contentMediaType`);
          }
        } else {
          throw new Error(`${where}: media type ${responseContentType} is not supported`);
        }
      }

      const errorStatuses = Object.keys(op.responses ?? {})
        .filter((c) => !/^2[0-9][0-9]$/.test(c))
        .map((c) => {
          if (!/^[45][0-9][0-9]$/.test(c)) throw new Error(`${where}: response ${c} is not a 2xx, 4xx or 5xx status`);
          return Number(c);
        })
        .sort((a, b) => a - b);

      const parameterSchemas = [];
      for (const parameter of op.parameters ?? []) {
        const resolved = parameter.$ref !== undefined ? resolveRef(doc, parameter.$ref) : parameter;
        if (!isObject(resolved)) throw new Error(`${where}: parameter ${parameter.$ref} does not resolve`);
        if (resolved.schema?.$ref !== undefined) parameterSchemas.push(refName(resolved.schema.$ref));
      }

      operations.push({
        operationId: id,
        method,
        path,
        summary: op.summary ?? '',
        successStatus: Number(code),
        requestSchema,
        responseSchema,
        responseContentType,
        errorStatuses,
        parameterSchemas,
      });
    }
  }
  for (const id of Object.keys(excluded)) {
    if (!seen.has(id)) throw new Error(`EXCLUDED_OPERATIONS names ${id}, which the contract does not have`);
  }
  return operations;
}

/** Names of the component schemas reachable from `roots`, in components order. */
export function reachableSchemas(doc, roots) {
  const components = doc.components?.schemas ?? {};
  const found = new Set();
  const visitNode = (node) => {
    if (!isObject(node)) return;
    if (node.$ref !== undefined) visitName(refName(node.$ref));
    if (isObject(node.properties)) Object.values(node.properties).forEach(visitNode);
    if (node.items !== undefined) visitNode(node.items);
  };
  const visitName = (name) => {
    if (found.has(name)) return;
    if (!Object.hasOwn(components, name)) throw new Error(`schema ${name} is referenced but not defined`);
    found.add(name);
    visitNode(components[name]);
  };
  roots.forEach(visitName);
  return Object.keys(components).filter((name) => found.has(name));
}

/** `{ namespace -> { type, ids } }` for every list of the bundled vocabulary. */
function vocabularyLists(files) {
  const lists = new Map();
  for (const list of describeVocabulary(files).lists) {
    lists.set(list.namespace, { type: `Vocabulary.${upperCamel(singular(list.namespace))}`, ids: list.items.map((i) => i.id) });
  }
  return lists;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Classifies every reachable component: `{ kind, swift, ... }` where kind is
 * struct, vocabulary, language, alias or date.
 */
function classifyComponents(doc, names, lists) {
  const components = doc.components.schemas;
  const kinds = new Map();
  for (const name of names) {
    const schema = components[name];
    const where = `components.schemas.${name}`;
    checkKeywords(schema, where);
    if (SUPPORT_TYPES.has(name) && !Object.values(DATE_COMPONENTS).includes(name)) {
      throw new Error(`${where}: the name ${name} is taken by a generated support type`);
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`${where}: name must be UpperCamelCase`);
    if (schema.$ref !== undefined) throw new Error(`${where}: a component that is only a $ref is not supported`);
    if (schema.format !== undefined) {
      const expected = DATE_COMPONENTS[schema.format];
      if (expected === undefined || schema.type !== 'string') throw new Error(`${where}: format ${schema.format} is not supported`);
      if (name !== expected) throw new Error(`${where}: format ${schema.format} must be the component ${expected}`);
      kinds.set(name, { kind: 'date', swift: `API.${name}` });
    } else if (schema.enum !== undefined) {
      if (schema['x-i18n-languages'] === true) {
        kinds.set(name, { kind: 'language', swift: 'VocabularyLanguage' });
      } else if (typeof schema['x-vocabulary'] === 'string') {
        const namespace = schema['x-vocabulary'];
        const list = lists.get(namespace);
        if (list === undefined) throw new Error(`${where}: x-vocabulary ${namespace} is not a list of the bundled vocabulary`);
        if (!sameSet(schema.enum, list.ids)) {
          const missing = schema.enum.filter((id) => !list.ids.includes(id));
          const extra = list.ids.filter((id) => !schema.enum.includes(id));
          throw new Error(
            `${where}: enum differs from ${namespace} in the bundled vocabulary ` +
              `(not in the vocabulary: ${missing.join(', ') || '-'}; not in the contract: ${extra.join(', ') || '-'})`,
          );
        }
        kinds.set(name, { kind: 'vocabulary', swift: list.type, namespace });
      } else {
        throw new Error(`${where}: an enum without x-vocabulary or x-i18n-languages is not supported`);
      }
    } else if (schema.type === 'object') {
      kinds.set(name, { kind: 'struct', swift: `API.${name}` });
    } else if (['string', 'integer', 'number', 'boolean'].includes(schema.type)) {
      kinds.set(name, { kind: 'alias', swift: `API.${name}`, base: scalarSwift(schema.type) });
    } else {
      throw new Error(`${where}: type ${schema.type} is not supported as a component`);
    }
  }
  return kinds;
}

function scalarSwift(type) {
  switch (type) {
    case 'string': return 'String';
    case 'integer': return 'Int';
    case 'number': return 'Double';
    case 'boolean': return 'Bool';
    default: throw new Error(`type ${type} is not a scalar`);
  }
}

/** Swift type of a property schema, and the component name of an object it holds (or of its elements). */
function propertyType(node, kinds, where) {
  if (!isObject(node)) throw new Error(`${where}: not a schema`);
  checkKeywords(node, where);
  if (node.$ref !== undefined) {
    const name = refName(node.$ref);
    const kind = kinds.get(name);
    if (kind === undefined) throw new Error(`${where}: ${name} is not classified`);
    return { swift: kind.swift, object: kind.kind === 'struct' ? name : null, component: name, isArray: false };
  }
  if (node.enum !== undefined || node.format !== undefined || node['x-vocabulary'] !== undefined) {
    throw new Error(`${where}: an inline enum or format is not supported; use a component`);
  }
  if (node.type === 'array') {
    const element = propertyType(node.items, kinds, `${where}.items`);
    if (element.isArray) throw new Error(`${where}: nested arrays are not supported`);
    return { swift: `[${element.swift}]`, object: element.object, component: element.component, isArray: true, element };
  }
  if (node.type === 'object') throw new Error(`${where}: an inline object is not supported; use a component`);
  return { swift: scalarSwift(node.type), object: null, component: null, isArray: false };
}

/** Folds whitespace and wraps `text` into `///` lines of at most about 100 columns. */
function docLines(text, indent) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  const width = 100 - indent.length - 4;
  for (const word of words) {
    if (current !== '' && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines.map((l) => `${indent}/// ${l}`);
}

/** Describes one object component as a Swift struct. */
function describeStruct(doc, name, kinds, lists, groups) {
  const schema = doc.components.schemas[name];
  const where = `components.schemas.${name}`;
  if (schema.additionalProperties !== false) throw new Error(`${where}: objects must have additionalProperties: false`);
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  for (const key of required) if (!Object.hasOwn(properties, key)) throw new Error(`${where}: required ${key} is not a property`);

  const group = groups.find((g) => g.schema === name);
  if (schema.not !== undefined || group !== undefined) {
    const notRequired = schema.not?.required;
    const keys = Object.keys(schema.not ?? {});
    if (group === undefined) throw new Error(`${where}: \`not\` is supported only for the pairs in EXCLUSIVE_GROUPS`);
    if (keys.length !== 1 || keys[0] !== 'required' || !Array.isArray(notRequired) || !sameSet(notRequired, Object.keys(group.cases))) {
      throw new Error(`${where}: EXCLUSIVE_GROUPS expects not: { required: [${Object.keys(group.cases).join(', ')}] }`);
    }
    for (const key of notRequired) {
      if (!Object.hasOwn(properties, key)) throw new Error(`${where}: exclusive ${key} is not a property`);
      if (required.includes(key)) throw new Error(`${where}: exclusive ${key} must be optional`);
    }
  }

  const fields = [];
  const groupMembers = [];
  for (const [json, node] of Object.entries(properties)) {
    const type = propertyType(node, kinds, `${where}.${json}`);
    const field = {
      json,
      swift: swiftMember(json),
      type,
      optional: !required.includes(json),
      description: node.description ?? '',
      lossy: type.isArray && type.object !== null,
    };
    if (STRUCT_MEMBERS.has(lowerCamel(json))) throw new Error(`${where}: property ${json} clashes with a generated member`);
    if (group !== undefined && Object.hasOwn(group.cases, json)) {
      groupMembers.push(field);
      if (groupMembers.length === 1) fields.push({ group: true, swift: swiftMember(group.property), members: groupMembers });
      continue;
    }
    // A scaled integer (ADR 0004) gets a helper in the unit of its vocabulary range.
    const target = node.$ref !== undefined ? doc.components.schemas[refName(node.$ref)] : node;
    if (target['x-vocabulary-scale'] !== undefined) {
      const scale = target['x-vocabulary-scale'];
      const range = target['x-vocabulary-range'];
      if (!Number.isInteger(scale) || scale < 2 || typeof range !== 'string' || type.swift !== kinds.get(type.component)?.swift || kinds.get(type.component)?.base !== 'Int') {
        throw new Error(`${where}.${json}: x-vocabulary-scale needs an integer component with x-vocabulary-range`);
      }
      const unit = range.split('.').pop();
      const helper = swiftMember(unit.replace(/_g$/, '_grams'));
      if (helper === field.swift || Object.hasOwn(properties, unit)) throw new Error(`${where}.${json}: helper ${helper} clashes`);
      field.scaled = { scale, range, helper };
    }
    fields.push(field);
  }
  if (group !== undefined) {
    const caseNames = Object.values(group.cases);
    if (new Set(caseNames).size !== caseNames.length) throw new Error(`${where}: two exclusive cases share a name`);
    if (Object.hasOwn(properties, group.property)) throw new Error(`${where}: ${group.property} is already a property`);
  }

  let keyed = null;
  if (schema['x-vocabulary-keys'] !== undefined) {
    const namespace = schema['x-vocabulary-keys'];
    const list = lists.get(namespace);
    if (list === undefined) throw new Error(`${where}: x-vocabulary-keys ${namespace} is not a list of the bundled vocabulary`);
    if (!sameSet(Object.keys(properties), list.ids)) throw new Error(`${where}: properties differ from the ids of ${namespace}`);
    const plain = fields.filter((f) => !f.group);
    const types = new Set(plain.map((f) => f.type.swift));
    const optionals = new Set(plain.map((f) => f.optional));
    if (types.size !== 1 || optionals.size !== 1) throw new Error(`${where}: x-vocabulary-keys needs one type for every property`);
    keyed = {
      namespace,
      keyType: list.type,
      parameter: swiftMember(singular(namespace)),
      valueType: `${plain[0].type.swift}${plain[0].optional ? '?' : ''}`,
      cases: list.ids.map((id) => ({ swiftCase: swiftCase(namespace, id), property: swiftMember(id) })),
    };
  }

  const custom = group !== undefined || fields.some((f) => f.lossy);
  return { name, description: schema.description ?? '', fields, group, keyed, custom };
}

/** Everything the Swift file needs, from the contract and the bundled vocabulary. */
export function describeApi(doc, vocabularyFiles, { excluded = EXCLUDED_OPERATIONS, groups = EXCLUSIVE_GROUPS } = {}) {
  const operations = describeOperations(doc, excluded);
  const roots = operations.flatMap((op) => [op.requestSchema, op.responseSchema, ...op.parameterSchemas]).filter(Boolean);
  const names = reachableSchemas(doc, roots);
  const lists = vocabularyLists(vocabularyFiles);
  const kinds = classifyComponents(doc, names, lists);
  for (const group of groups) {
    if (!names.includes(group.schema)) throw new Error(`EXCLUSIVE_GROUPS names ${group.schema}, which no generated type uses`);
    if (SUPPORT_TYPES.has(group.type) || kinds.has(group.type)) throw new Error(`EXCLUSIVE_GROUPS type ${group.type} clashes`);
  }
  const structs = names.filter((n) => kinds.get(n).kind === 'struct').map((n) => describeStruct(doc, n, kinds, lists, groups));
  const aliases = names
    .filter((n) => kinds.get(n).kind === 'alias')
    .map((n) => ({ name: n, base: kinds.get(n).base, schema: doc.components.schemas[n] }));
  const usesLanguage = names.some((n) => kinds.get(n).kind === 'language');
  return { operations, names, kinds, structs, aliases, usesLanguage };
}

function aliasDoc(alias) {
  const s = alias.schema;
  const facts = [];
  if (s.minimum !== undefined && s.maximum !== undefined) facts.push(`${s.minimum} to ${s.maximum}`);
  if (s.multipleOf !== undefined) facts.push(`step ${s.multipleOf}`);
  if (s.pattern !== undefined) facts.push(`pattern ${s.pattern}`);
  if (s['x-vocabulary-range'] !== undefined) facts.push(`vocabulary range ${s['x-vocabulary-range']}`);
  if (s['x-vocabulary-scale'] !== undefined) facts.push(`scale ${s['x-vocabulary-scale']}`);
  const head = `\`${alias.name}\`${facts.length > 0 ? ` (${facts.join('; ')})` : ''}.`;
  return `${head} ${s.description ?? ''}`;
}

const CALENDAR_DATE_SWIFT = `
    /// \`CalendarDate\`: a day, \`YYYY-MM-DD\`, with no time and no time zone. The same day
    /// everywhere; convert from a \`Date\` only with the time zone the user meant.
    struct CalendarDate: Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
        let year: Int
        let month: Int
        let day: Int

        /// Nil unless the day exists in the Gregorian calendar, years 1 to 9999.
        init?(year: Int, month: Int, day: Int) {
            guard (1...9999).contains(year),
                  (1...12).contains(month),
                  (1...CalendarDate.daysInMonth(year: year, month: month)).contains(day) else {
                return nil
            }
            self.year = year
            self.month = month
            self.day = day
        }

        /// Parses exactly \`YYYY-MM-DD\`; nil for anything else.
        init?(_ text: String) {
            let parts = text.split(separator: "-", omittingEmptySubsequences: false)
            guard parts.count == 3,
                  parts.map(\\.count) == [4, 2, 2],
                  parts.allSatisfy({ part in part.allSatisfy { $0.isASCII && $0.isNumber } }),
                  let year = Int(parts[0]),
                  let month = Int(parts[1]),
                  let day = Int(parts[2]) else {
                return nil
            }
            self.init(year: year, month: month, day: day)
        }

        /// The Gregorian day that \`date\` falls on in \`timeZone\`.
        init?(date: Date, timeZone: TimeZone) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let components = calendar.dateComponents([.year, .month, .day], from: date)
            guard let year = components.year, let month = components.month, let day = components.day else {
                return nil
            }
            self.init(year: year, month: month, day: day)
        }

        /// \`YYYY-MM-DD\`, as sent.
        var description: String {
            "\\(API.zeroPadded(year, width: 4))-\\(API.zeroPadded(month, width: 2))-\\(API.zeroPadded(day, width: 2))"
        }

        static func < (lhs: CalendarDate, rhs: CalendarDate) -> Bool {
            (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
        }

        /// Days in \`month\` of \`year\` in the Gregorian calendar.
        static func daysInMonth(year: Int, month: Int) -> Int {
            switch month {
            case 2:
                let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
                return leap ? 29 : 28
            case 4, 6, 9, 11:
                return 30
            default:
                return 31
            }
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let value = CalendarDate(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected a calendar date, YYYY-MM-DD.")
            }
            self = value
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(description)
        }
    }
`;

const TIMESTAMP_SWIFT = `
    /// \`Timestamp\`: an instant, sent as RFC 3339 in UTC with milliseconds
    /// (\`2026-11-25T08:30:00.123Z\`). Held as whole milliseconds, so a value survives a round
    /// trip through JSON unchanged. Decoding accepts any offset, with or without fractional seconds.
    struct Timestamp: Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
        /// Milliseconds since 1970-01-01T00:00:00Z.
        let millisecondsSince1970: Int64

        /// 0001-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z, the instants RFC 3339 can write.
        static let validRange: ClosedRange<Int64> = -62_135_596_800_000...253_402_300_799_999

        /// Nil outside \`validRange\`.
        init?(millisecondsSince1970: Int64) {
            guard Timestamp.validRange.contains(millisecondsSince1970) else {
                return nil
            }
            self.millisecondsSince1970 = millisecondsSince1970
        }

        /// \`date\`, rounded to the millisecond; nil outside \`validRange\`.
        init?(_ date: Date) {
            let milliseconds = (date.timeIntervalSince1970 * 1000).rounded()
            guard milliseconds.isFinite, let value = Int64(exactly: milliseconds) else {
                return nil
            }
            self.init(millisecondsSince1970: value)
        }

        /// Parses RFC 3339; nil for anything else.
        init?(rfc3339 text: String) {
            guard let date = Timestamp.parse(text) else {
                return nil
            }
            self.init(date)
        }

        var date: Date {
            Date(timeIntervalSince1970: Double(millisecondsSince1970) / 1000)
        }

        /// RFC 3339 in UTC with three fractional digits, as sent.
        var description: String {
            var seconds = millisecondsSince1970 / 1000
            var milliseconds = millisecondsSince1970 % 1000
            if milliseconds < 0 {
                seconds -= 1
                milliseconds += 1000
            }
            let whole = Timestamp.wholeSeconds.string(from: Date(timeIntervalSince1970: TimeInterval(seconds)))
            return "\\(whole.dropLast()).\\(API.zeroPadded(milliseconds, width: 3))Z"
        }

        static func < (lhs: Timestamp, rhs: Timestamp) -> Bool {
            lhs.millisecondsSince1970 < rhs.millisecondsSince1970
        }

        /// RFC 3339 with fractional seconds. Created once: an \`ISO8601DateFormatter\` is costly to
        /// make, and it is thread-safe once configured, which is why \`nonisolated(unsafe)\` is sound.
        nonisolated(unsafe) private static let fractionalSeconds: ISO8601DateFormatter = {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            return formatter
        }()

        /// RFC 3339 in whole seconds, in UTC. Created once, like \`fractionalSeconds\`.
        nonisolated(unsafe) private static let wholeSeconds: ISO8601DateFormatter = {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            return formatter
        }()

        private static func parse(_ text: String) -> Date? {
            fractionalSeconds.date(from: text) ?? wholeSeconds.date(from: text)
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let value = Timestamp(rfc3339: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an RFC 3339 timestamp.")
            }
            self = value
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(description)
        }
    }
`;

const SUPPORT_SWIFT = `
    /// An element of a list in a response that did not decode, for example because it holds an
    /// id the bundled vocabulary does not know. The rest of the list still decodes. \`reason\` is
    /// the decoding error, for diagnostics only; it may hold server data, so never log it.
    struct UndecodableItem: Hashable, Sendable {
        /// JSON name of the list.
        let property: String
        /// Position of the element in the list as received.
        let index: Int
        let reason: String
    }

    /// Decodes one element on its own and keeps the error instead of throwing it, so a list
    /// can skip the elements that fail.
    struct DecodingAttempt<Value: Decodable>: Decodable {
        let value: Value?
        let failure: String?

        init(from decoder: Decoder) {
            let result = Result<Value, Error>(catching: { try Value(from: decoder) })
            switch result {
            case .success(let decoded):
                value = decoded
                failure = nil
            case .failure(let error):
                value = nil
                failure = String(describing: error)
            }
        }
    }

    /// The failed elements of a list decoded with \`DecodingAttempt\`.
    static func undecodableItems<Value: Decodable>(_ attempts: [DecodingAttempt<Value>], property: String) -> [UndecodableItem] {
        attempts.enumerated().compactMap { entry in
            entry.element.failure.map { reason in
                UndecodableItem(property: property, index: entry.offset, reason: reason)
            }
        }
    }

    /// \`value * scale\`, rounded to an integer; nil when that is not a finite \`Int\`.
    static func scaledInteger(_ value: Double, scale: Int) -> Int? {
        let scaled = (value * Double(scale)).rounded()
        guard scaled.isFinite else {
            return nil
        }
        return Int(exactly: scaled)
    }

    /// \`value\` in decimal with leading zeros to \`width\` digits.
    static func zeroPadded<Value: BinaryInteger>(_ value: Value, width: Int) -> String {
        let digits = String(value)
        return String(repeating: "0", count: max(0, width - digits.count)) + digits
    }
`;

function emitStruct(s, line) {
  const I = '        ';
  const II = '            ';
  const III = '                ';
  line('');
  for (const l of docLines(`\`${s.name}\`. ${s.description}`, '    ')) line(l);
  line(`    struct ${s.name}: APIObject {`);
  line(`${I}static let schemaName = ${swiftString(s.name)}`);
  const jsonNames = s.fields.flatMap((f) => (f.group ? f.members.map((m) => m.json) : [f.json]));
  line(`${I}static let propertyNames: Set<String> = [${[...jsonNames].sort().map(swiftString).join(', ')}]`);

  const stored = [];
  for (const f of s.fields) {
    if (f.group) {
      const g = s.group;
      stored.push({ swift: f.swift, type: `API.${g.type}?`, defaultValue: 'nil' });
      line('');
      for (const l of docLines(`${f.members.map((m) => `\`${m.json}\``).join(' or ')}, at most one of them. See \`API.${g.type}\`.`, I)) line(l);
      line(`${I}var ${f.swift}: API.${g.type}?`);
      continue;
    }
    const type = `${f.type.swift}${f.optional ? '?' : ''}`;
    stored.push({ swift: f.swift, type, defaultValue: f.optional ? 'nil' : null });
    line('');
    for (const l of docLines(`\`${f.json}\`.${f.lossy ? ' Elements that fail to decode are left out and listed in `undecodableItems`.' : ''} ${f.description}`, I)) line(l);
    line(`${I}var ${f.swift}: ${type}`);
  }
  const lossy = s.fields.filter((f) => f.lossy);
  if (lossy.length > 0) {
    stored.push({ swift: UNDECODABLE_PROPERTY, type: '[API.UndecodableItem]', defaultValue: '[]' });
    line('');
    line(`${I}/// Elements of ${lossy.map((f) => `\`${f.json}\``).join(', ')} that did not decode. Never encoded.`);
    line(`${I}var ${UNDECODABLE_PROPERTY}: [API.UndecodableItem]`);
  }

  // Memberwise init, optionals defaulting to nil.
  line('');
  if (stored.length === 0) {
    line(`${I}init() {}`);
  } else {
    line(`${I}init(`);
    stored.forEach((p, i) => {
      const def = p.defaultValue !== null ? ` = ${p.defaultValue}` : '';
      line(`${II}${p.swift}: ${p.type}${def}${i < stored.length - 1 ? ',' : ''}`);
    });
    line(`${I}) {`);
    for (const p of stored) line(`${II}self.${p.swift} = ${p.swift}`);
    line(`${I}}`);
  }

  // CodingKeys: every JSON name of the contract, and nothing else.
  line('');
  const keyFields = s.fields.flatMap((f) => (f.group ? f.members : [f]));
  if (keyFields.length === 0) {
    line(`${I}enum CodingKeys: CodingKey {}`);
  } else {
    line(`${I}enum CodingKeys: String, CodingKey {`);
    for (const f of keyFields) line(`${II}case ${f.swift} = ${swiftString(f.json)}`);
    line(`${I}}`);
  }

  if (s.custom) {
    line('');
    line(`${I}init(from decoder: Decoder) throws {`);
    line(`${II}let container = try decoder.container(keyedBy: CodingKeys.self)`);
    for (const f of s.fields) {
      if (f.group) {
        const g = s.group;
        const values = `${lowerCamel(g.property)}Values`;
        line(`${II}var ${values}: [API.${g.type}] = []`);
        for (const m of f.members) {
          line(`${II}if let value = try container.decodeIfPresent(${m.type.swift}.self, forKey: .${m.swift}) {`);
          line(`${III}${values}.append(.${g.cases[m.json]}(value))`);
          line(`${II}}`);
        }
        line(`${II}guard ${values}.count <= 1 else {`);
        line(`${III}throw DecodingError.dataCorruptedError(`);
        line(`${III}    forKey: .${f.members[f.members.length - 1].swift},`);
        line(`${III}    in: container,`);
        line(`${III}    debugDescription: ${swiftString(`${f.members.map((m) => m.json).join(' and ')} exclude each other.`)}`);
        line(`${III})`);
        line(`${II}}`);
        line(`${II}self.${f.swift} = ${values}.first`);
      } else if (f.lossy) {
        const attempts = `${lowerCamel(f.json)}Attempts`;
        const attemptType = `[API.DecodingAttempt<${f.type.element.swift}>]`;
        if (f.optional) {
          line(`${II}let ${attempts} = try container.decodeIfPresent(${attemptType}.self, forKey: .${f.swift})`);
          line(`${II}self.${f.swift} = ${attempts}?.compactMap { attempt in attempt.value }`);
        } else {
          line(`${II}let ${attempts} = try container.decode(${attemptType}.self, forKey: .${f.swift})`);
          line(`${II}self.${f.swift} = ${attempts}.compactMap { attempt in attempt.value }`);
        }
      } else {
        const call = f.optional ? 'decodeIfPresent' : 'decode';
        line(`${II}self.${f.swift} = try container.${call}(${f.type.swift}.self, forKey: .${f.swift})`);
      }
    }
    if (lossy.length > 0) {
      const parts = lossy.map((f) => {
        const attempts = `${lowerCamel(f.json)}Attempts${f.optional ? ' ?? []' : ''}`;
        return `API.undecodableItems(${attempts}, property: ${swiftString(f.json)})`;
      });
      line(`${II}self.${UNDECODABLE_PROPERTY} = ${parts.join(' + ')}`);
    }
    line(`${I}}`);
    line('');
    line(`${I}func encode(to encoder: Encoder) throws {`);
    line(`${II}var container = encoder.container(keyedBy: CodingKeys.self)`);
    for (const f of s.fields) {
      if (f.group) {
        const g = s.group;
        line(`${II}if let value = self.${f.swift} {`);
        line(`${III}switch value {`);
        for (const m of f.members) {
          line(`${III}case .${g.cases[m.json]}(let member):`);
          line(`${III}    try container.encode(member, forKey: .${m.swift})`);
        }
        line(`${III}}`);
        line(`${II}}`);
      } else {
        const call = f.optional ? 'encodeIfPresent' : 'encode';
        line(`${II}try container.${call}(${f.swift}, forKey: .${f.swift})`);
      }
    }
    line(`${I}}`);
  }

  for (const f of s.fields) {
    if (f.group || f.scaled === undefined) continue;
    const { scale, range, helper } = f.scaled;
    line('');
    line(`${I}/// \`${f.json}\` in the unit of ${range} (scale ${scale}, ADR 0004).`);
    if (f.optional) {
      line(`${I}/// Setting it rounds to the nearest 1/${scale}; a value that is not finite clears \`${f.swift}\`.`);
      line(`${I}var ${helper}: Double? {`);
      line(`${II}get { ${f.swift}.map { value in Double(value) / ${scale} } }`);
      line(`${II}set { ${f.swift} = newValue.flatMap { value in API.scaledInteger(value, scale: ${scale}) } }`);
      line(`${I}}`);
    } else {
      line(`${I}var ${helper}: Double {`);
      line(`${II}Double(${f.swift}) / ${scale}`);
      line(`${I}}`);
    }
  }

  if (s.keyed !== null) {
    const k = s.keyed;
    line('');
    line(`${I}/// The value for one entry of \`${k.namespace}\`.`);
    line(`${I}subscript(${k.parameter}: ${k.keyType}) -> ${k.valueType} {`);
    line(`${II}get {`);
    line(`${III}switch ${k.parameter} {`);
    for (const c of k.cases) line(`${III}case .${c.swiftCase}: return ${c.property}`);
    line(`${III}}`);
    line(`${II}}`);
    line(`${II}set {`);
    line(`${III}switch ${k.parameter} {`);
    for (const c of k.cases) line(`${III}case .${c.swiftCase}: ${c.property} = newValue`);
    line(`${III}}`);
    line(`${II}}`);
    line(`${I}}`);
  }
  line('    }');

  if (s.group !== undefined) {
    const g = s.group;
    const members = s.fields.find((f) => f.group).members;
    line('');
    for (const l of docLines(`${members.map((m) => `\`${m.json}\``).join(' or ')} of \`${s.name}\`: the contract allows at most one (\`not: required\`), so they are one value.`, '    ')) line(l);
    line(`    enum ${g.type}: Hashable, Sendable {`);
    for (const m of members) {
      line(`        /// \`${m.json}\``);
      line(`        case ${g.cases[m.json]}(${m.type.swift})`);
    }
    line('    }');
  }
}

/** The Swift source for the contract, typed with the bundled vocabulary `version`. */
export function generateSwift({ doc, vocabularyVersion, vocabularyFiles, options }) {
  const api = describeApi(doc, vocabularyFiles, options);
  for (const s of api.structs) if (SUPPORT_TYPES.has(s.name)) throw new Error(`schema ${s.name} clashes with a support type`);
  const out = [];
  const line = (text = '') => out.push(text);
  const contractVersion = String(doc.info?.version ?? '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(contractVersion)) throw new Error('info.version must be x.y.z');

  line(`// Generated by scripts/generate-ios-api.mjs from contracts/openapi.yaml ${contractVersion}`);
  line(`// and contracts/vocabulary/v${vocabularyVersion}/. Do not edit. Run \`node scripts/generate-ios-api.mjs\`.`);
  line('');
  line('import Foundation');
  line('');
  line('/// A JSON object of the API contract. Encoding writes only `propertyNames`, never null.');
  line('protocol APIObject: Codable, Hashable, Sendable {');
  line('    /// The schema name in contracts/openapi.yaml.');
  line('    static var schemaName: String { get }');
  line('    /// Every JSON property the contract allows on this schema.');
  line('    static var propertyNames: Set<String> { get }');
  line('}');
  line('');
  line('/// Request and response types of contracts/openapi.yaml, for every route the app calls.');
  line('/// Vocabulary values use the `Vocabulary` enums, so no list is defined twice.');
  line('enum API {');
  line('    /// `info.version` of contracts/openapi.yaml.');
  line(`    static let contractVersion = ${swiftString(contractVersion)}`);
  line('');
  line('    // MARK: - Routes');
  line('');
  line('    enum HTTPMethod: String, CaseIterable, Sendable {');
  for (const method of HTTP_METHODS.filter((m) => api.operations.some((op) => op.method === m))) {
    line(`        case ${method} = ${swiftString(method.toUpperCase())}`);
  }
  line('    }');
  line('');
  line('    /// Every operation the app calls, by operationId.');
  const excludedNote = Object.entries(options?.excluded ?? EXCLUDED_OPERATIONS).map(([id, why]) => `${id} (${why})`).join('; ');
  if (excludedNote !== '') for (const l of docLines(`Not here: ${excludedNote}.`, '    ')) line(l);
  line('    enum Endpoint: String, CaseIterable, Sendable {');
  for (const op of api.operations) {
    for (const l of docLines(`${op.method.toUpperCase()} ${op.path}. ${op.summary}`, '        ')) line(l);
    line(`        case ${swiftMember(op.operationId)} = ${swiftString(op.operationId)}`);
  }
  const switchProperty = (doc1, name, type, value) => {
    line('');
    line(`        /// ${doc1}`);
    line(`        var ${name}: ${type} {`);
    line('            switch self {');
    for (const op of api.operations) line(`            case .${swiftMember(op.operationId)}: return ${value(op)}`);
    line('            }');
    line('        }');
  };
  const optionalString = (v) => (v === null ? 'nil' : swiftString(v));
  switchProperty('The HTTP method.', 'method', 'API.HTTPMethod', (op) => `.${op.method}`);
  switchProperty('The path template, with `{name}` for each path parameter.', 'path', 'String', (op) => swiftString(op.path));
  switchProperty('The status code of success.', 'successStatus', 'Int', (op) => String(op.successStatus));
  switchProperty('`schemaName` of the JSON request body, or nil when the request has no body.', 'requestSchema', 'String?', (op) => optionalString(op.requestSchema));
  switchProperty('`schemaName` of the JSON success body, or nil when it is not JSON or empty.', 'responseSchema', 'String?', (op) => optionalString(op.responseSchema));
  switchProperty('Media type of the success body, or nil when it has none.', 'responseContentType', 'String?', (op) => optionalString(op.responseContentType));
  switchProperty('The error statuses the contract lists for the route, ascending. Any 5xx can also occur.', 'documentedErrorStatuses', '[Int]', (op) => `[${op.errorStatuses.join(', ')}]`);
  line('    }');

  line('');
  line('    // MARK: - Plain values');
  for (const alias of api.aliases) {
    line('');
    for (const l of docLines(aliasDoc(alias), '    ')) line(l);
    line(`    typealias ${alias.name} = ${alias.base}`);
  }

  line('');
  line('    // MARK: - Objects');
  for (const s of api.structs) emitStruct(s, line);

  line('');
  line('    // MARK: - Dates');
  line('');
  if (api.names.includes(DATE_COMPONENTS.date)) out.push(CALENDAR_DATE_SWIFT.replace(/^\n/, '').replace(/\n$/, ''));
  if (api.names.includes(DATE_COMPONENTS['date-time'])) {
    line('');
    out.push(TIMESTAMP_SWIFT.replace(/^\n/, '').replace(/\n$/, ''));
  }

  line('');
  line('    // MARK: - Support');
  out.push(SUPPORT_SWIFT.replace(/\n$/, ''));

  line('');
  line('    /// The contract shape of every generated object, for tests that walk encoded JSON.');
  line('    enum Schemas {');
  line('        /// Every JSON property of each object schema, by schema name.');
  line('        static let properties: [String: Set<String>] = [');
  for (const s of api.structs) {
    const names = s.fields.flatMap((f) => (f.group ? f.members.map((m) => m.json) : [f.json])).sort();
    line(`            ${swiftString(s.name)}: [${names.map(swiftString).join(', ')}],`);
  }
  line('        ]');
  line('');
  line('        /// For each object schema, the properties that hold another object schema or a list of one.');
  line('        static let nested: [String: [String: String]] = [');
  for (const s of api.structs) {
    const nested = s.fields.filter((f) => !f.group && f.type.object !== null).map((f) => [f.json, f.type.object]).sort((a, b) => a[0].localeCompare(b[0]));
    const body = nested.length === 0 ? ':' : nested.map(([k, v]) => `${swiftString(k)}: ${swiftString(v)}`).join(', ');
    line(`            ${swiftString(s.name)}: [${body}],`);
  }
  line('        ]');
  line('    }');
  line('}');
  if (api.usesLanguage) {
    line('');
    line('/// `Locale` of the contract (`x-i18n-languages`): the label languages, as their codes.');
    line('extension VocabularyLanguage: Codable {}');
  }
  line('');
  return out.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  // --file=<path> compares or writes another file than GENERATED_FILE; the script tests use it.
  const fileArgument = process.argv.find((a) => a.startsWith('--file='));
  const file = fileArgument === undefined ? GENERATED_FILE : resolve(fileArgument.slice('--file='.length));
  const vocabularyVersion = latestPublishedVersion();
  const source = generateSwift({ doc: loadOpenApi(), vocabularyVersion, vocabularyFiles: loadVocabulary(vocabularyVersion) });
  const target = relative(root, file);

  if (!check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    console.log(`generate-ios-api: wrote ${target} from contracts/openapi.yaml and vocabulary v${vocabularyVersion}`);
    return;
  }
  let committed;
  try {
    committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    committed = undefined;
  }
  if (committed === undefined) {
    console.error(`generate-ios-api: FAILED. ${target} is missing. Run \`node scripts/generate-ios-api.mjs\`.`);
    process.exit(1);
  }
  if (committed !== source) {
    console.error(
      `generate-ios-api: FAILED. ${target} is out of date with contracts/. ` +
        'Run `node scripts/generate-ios-api.mjs` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`generate-ios-api: ${target} is up to date with contracts/openapi.yaml and vocabulary v${vocabularyVersion}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

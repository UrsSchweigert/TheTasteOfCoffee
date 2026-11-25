#!/usr/bin/env node
// Generates ios/Cupmark/Generated/Vocabulary.swift from the latest published
// vocabulary in contracts/vocabulary/ and the languages in contracts/i18n/
// (backlog M0-T6). The app never hand-types a list: every enum, range and
// constant in that file comes from here.
//
// With --check it writes nothing and exits 1 if the committed file differs
// from a fresh generation, or if the Xcode project does not bundle the
// version the Swift types were generated from (no drift between contracts/
// and the app). Runs on Linux; needs Node 22 and `npm ci` in contracts/.
//
// Usage: node scripts/generate-ios-vocabulary.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_RANGES,
  FIELD_RULES_KEY,
  LANGUAGES,
  METHOD_FIELD,
  PARENT_REFERENCES,
  QUESTION_NAMESPACES,
  SCALED_FIELDS,
  checkEntryRanges,
  checkFieldRules,
  checkParentReferences,
  collectIds,
  isExactStep,
  listVersions,
  loadI18n,
  loadVocabulary,
} from '../contracts/lib/vocabulary.mjs';
import { isPublished } from '../contracts/lib/lock.mjs';
import { loadOpenApi } from '../contracts/lib/openapi.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_FILE = join(root, 'ios', 'Cupmark', 'Generated', 'Vocabulary.swift');
export const PROJECT_FILE = join(root, 'ios', 'Cupmark.xcodeproj', 'project.pbxproj');

// Swift keywords that need backticks when used as an identifier.
const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init',
  'inout', 'internal', 'let', 'open', 'operator', 'private', 'precedencegroup', 'protocol', 'public',
  'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'catch', 'continue',
  'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return',
  'throw', 'switch', 'where', 'while', 'as', 'any', 'false', 'is', 'nil', 'self', 'super', 'throws',
  'true', 'try', 'await', 'async', 'some',
]);
// Names an enum case or property must not take, because the generated enums
// already have a member of that name (RawRepresentable, CaseIterable,
// Identifiable, VocabularyItem).
const RESERVED_MEMBERS = new Set(['rawValue', 'allCases', 'id', 'namespace', 'hashValue', 'self']);
// Type names the generator itself uses inside `enum Vocabulary`.
const RESERVED_TYPES = new Set(['Namespace', 'Ranges', 'Constants', 'Language', 'BrewField']);
const RANGE_KEYS = ['maximum', 'minimum', 'multipleOf'];
const TOP_LEVEL_META = new Set(['version', 'status']);
// Words that are the same in singular and plural.
const INVARIANT_PLURALS = new Set(['species', 'series']);

/** `moka_pot` -> `mokaPot`, `from_15_to_30` -> `from15To30`. */
export function lowerCamel(snake) {
  return snake
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** `flavour_categories` -> `FlavourCategories`. */
export function upperCamel(snake) {
  const camel = lowerCamel(snake);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Singular of a namespace's last word, for the Swift type name:
 * `methods` -> `method`, `flavour_categories` -> `flavour_category`,
 * `processes` -> `process`, `criteria` -> `criterion`, `species` -> `species`.
 * A name that does not end in a known plural stays as it is
 * (`water_temp_special`).
 */
export function singular(snake) {
  const parts = snake.split('_');
  const last = parts.pop();
  let one = last;
  if (INVARIANT_PLURALS.has(last)) one = last;
  else if (last === 'criteria') one = 'criterion';
  else if (last.endsWith('ies')) one = `${last.slice(0, -3)}y`;
  else if (last.endsWith('sses') || last.endsWith('shes') || last.endsWith('ches') || last.endsWith('xes')) one = last.slice(0, -2);
  else if (last.endsWith('s') && !last.endsWith('ss')) one = last.slice(0, -1);
  return [...parts, one].join('_');
}

/** A Swift identifier for a member, with backticks for keywords. */
export function swiftMember(snake) {
  const name = lowerCamel(snake);
  if (RESERVED_MEMBERS.has(name)) throw new Error(`"${snake}" would become the reserved Swift member "${name}"`);
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

// Ids that compile as an enum case but read as Optional's own cases, so
// `let milk: MilkType? = .none` would silently mean nil. Such an id becomes
// `<prefix><Subject>`, where the subject is the list's singular name without a
// trailing `_type` or `_kind`: `none` in `milk_types` -> `noMilk`. The raw
// value stays the contract id.
const OPTIONAL_LOOKALIKES = new Map([
  ['none', 'no'],
  ['some', 'some'],
]);

/** `milk_types` -> `Milk`, `methods` -> `Method`, `water_temp_special` -> `WaterTempSpecial`. */
export function listSubject(namespace) {
  return upperCamel(singular(namespace).replace(/_(type|kind)$/, ''));
}

/**
 * The Swift case name for an id of a list. Usually `swiftMember(id)`; an id
 * that would shadow `Optional.none` or `Optional.some` is renamed (see
 * OPTIONAL_LOOKALIKES), so `.none` in app code always means nil.
 */
export function swiftCase(namespace, id) {
  const prefix = OPTIONAL_LOOKALIKES.get(lowerCamel(id));
  if (prefix === undefined) return swiftMember(id);
  return `${prefix}${listSubject(namespace)}`;
}

/** Swift string literal. JSON escapes differ from Swift's for \u, so escape by hand. */
export function swiftString(text) {
  let out = '"';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Swift literal for a JSON number, as Double or Int. */
function swiftNumber(value, type) {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  if (type === 'Int') return String(value);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIdList = (v) => Array.isArray(v) && v.length > 0 && v.every((item) => isObject(item) && 'id' in item);
const isRange = (v) =>
  isObject(v) &&
  Object.keys(v).sort().join(',') === RANGE_KEYS.join(',') &&
  RANGE_KEYS.every((k) => typeof v[k] === 'number');

function scalarType(value) {
  if (typeof value === 'boolean') return 'Bool';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Double';
  return undefined;
}

function mergeType(a, b) {
  if (a === undefined) return b;
  if (a === b) return a;
  if ((a === 'Int' && b === 'Double') || (a === 'Double' && b === 'Int')) return 'Double';
  return null;
}

/**
 * Walks the vocabulary files and returns everything the Swift file needs:
 * `{ lists, ranges, constants, fieldRules }`.
 * - lists: `{ namespace, file, items: [{ id, attributes, children, ranges }], parent }`
 *   in file order; `children` maps a nested namespace to its ids, `ranges`
 *   holds the entry's own range under the attribute ENTRY_RANGES names for
 *   the list (a grinder's `scale`), if it has one.
 * - ranges: `{ path, name, minimum, maximum, multipleOf }` for every object
 *   that is exactly `{ minimum, maximum, multipleOf }`.
 * - constants: `{ path, name, value }` for every other scalar outside a list
 *   (top-level `version` and `status` excepted).
 * - fieldRules: the method field rules, `brew.json` `field_rules`, as
 *   `[{ field, methods }]` in file order, or undefined if the version has
 *   none. They are rules, not constants: checkFieldRules (with the
 *   BrewParameters fields) validates them in generateSwift.
 * Throws on anything it cannot represent, so a new shape in vocabulary v<N>
 * fails here instead of being dropped silently.
 */
export function describeVocabulary(files) {
  const { problems } = collectIds(files);
  if (problems.length > 0) throw new Error(`vocabulary problems:\n${problems.join('\n')}`);

  const lists = [];
  const ranges = [];
  const constants = [];
  let fieldRules;

  // A nested list (flavour_notes under each flavour category) is one
  // namespace: its entries from every parent are merged into one list.
  const listFor = (namespace, file, parent) => {
    let list = lists.find((l) => l.namespace === namespace);
    if (list === undefined) {
      list = { namespace, file, items: [], parent };
      lists.push(list);
    } else if (list.parent !== parent) {
      throw new Error(`${namespace}: appears both nested and at top level, or under two parents`);
    }
    return list;
  };

  const visitList = (namespace, file, array, parent) => {
    const list = listFor(namespace, file, parent);
    for (const item of array) {
      const entry = { id: item.id, attributes: {}, children: {}, ranges: {} };
      list.items.push(entry);
      for (const [key, value] of Object.entries(item)) {
        if (key === 'id') continue;
        if (key === ENTRY_RANGES[namespace]) {
          if (!isRange(value)) throw new Error(`${file}.json: ${namespace}.${item.id}.${key} is not a range { minimum, maximum, multipleOf }`);
          entry.ranges[key] = { minimum: value.minimum, maximum: value.maximum, multipleOf: value.multipleOf };
          continue;
        }
        if (isIdList(value)) {
          entry.children[key] = value.map((child) => child.id);
          visitList(key, file, value, namespace);
          continue;
        }
        if (scalarType(value) === undefined) {
          throw new Error(`${file}.json: ${namespace}.${item.id}.${key} is neither a scalar nor an id list`);
        }
        entry.attributes[key] = value;
      }
    }
  };

  const visitObject = (object, file, path) => {
    for (const [key, value] of Object.entries(object)) {
      if (path.length === 0 && TOP_LEVEL_META.has(key)) continue;
      const childPath = [...path, key];
      if (key === FIELD_RULES_KEY) {
        if (file !== 'brew' || path.length !== 0) throw new Error(`${file}.json: ${childPath.join('.')}: field rules belong at the top of brew.json`);
        if (!isObject(value)) throw new Error(`${file}.json: ${FIELD_RULES_KEY} is not an object`);
        fieldRules = Object.entries(value).map(([field, rule]) => ({
          field,
          methods: isObject(rule?.allowed_methods) ? Object.keys(rule.allowed_methods) : [],
        }));
        continue;
      }
      if (isIdList(value)) {
        visitList(key, file, value, undefined);
      } else if (isRange(value)) {
        const nameParts = childPath[0] === 'ranges' ? childPath.slice(1) : childPath;
        ranges.push({ path: [file, ...childPath].join('.'), name: lowerCamel(nameParts.join('_')), ...value });
      } else if (isObject(value)) {
        visitObject(value, file, childPath);
      } else if (scalarType(value) !== undefined) {
        constants.push({ path: [file, ...childPath].join('.'), name: lowerCamel(childPath.join('_')), value });
      } else {
        throw new Error(`${file}.json: ${childPath.join('.')} has a shape the generator does not know`);
      }
    }
  };

  for (const file of Object.keys(files).sort()) visitObject(files[file], file, []);

  for (const group of [ranges, constants]) {
    const seen = new Map();
    for (const { name, path } of group) {
      if (seen.has(name)) throw new Error(`${path} and ${seen.get(name)} both become the Swift name ${name}`);
      seen.set(name, path);
    }
  }
  return { lists, ranges, constants, fieldRules };
}

/**
 * The BrewParameters fields of contracts/openapi.yaml, in schema order. The
 * method field rules may name any of them but `method`.
 */
export function brewParameterFields(openapi) {
  const properties = openapi?.components?.schemas?.BrewParameters?.properties;
  if (!isObject(properties)) throw new Error('openapi.yaml: components.schemas.BrewParameters.properties is missing');
  return Object.keys(properties);
}

function typeName(namespace) {
  const name = upperCamel(singular(namespace));
  if (RESERVED_TYPES.has(name)) throw new Error(`namespace ${namespace} would become the reserved type name ${name}`);
  return name;
}

/**
 * Swift properties for the scalar attributes of a list's entries. The
 * attribute PARENT_REFERENCES names for the list (`country` in `origins`) is
 * a reference to another entry of the same list, so it becomes
 * `Vocabulary.<Type>?` instead of a string; checkParentReferences in
 * contracts/lib/vocabulary.mjs guarantees every value is an id of the list.
 */
function attributeProperties(list) {
  const props = {};
  const parentKey = PARENT_REFERENCES[list.namespace];
  for (const item of list.items) {
    for (const [key, value] of Object.entries(item.attributes)) {
      const merged = mergeType(props[key], scalarType(value));
      if (merged === null) throw new Error(`${list.namespace}: attribute ${key} mixes types`);
      props[key] = merged;
    }
  }
  return Object.entries(props).map(([key, type]) => {
    const reference = key === parentKey;
    if (reference && type !== 'String') throw new Error(`${list.namespace}: ${key} must be an id`);
    return { key, type, reference, optional: reference || list.items.some((item) => !(key in item.attributes)) };
  });
}

function swiftScalar(value, type) {
  if (type === 'String') return swiftString(value);
  if (type === 'Bool') return value ? 'true' : 'false';
  return swiftNumber(value, type);
}

function jsonValueLiteral(value) {
  if (typeof value === 'string') return `.string(${swiftString(value)})`;
  if (typeof value === 'boolean') return `.bool(${value})`;
  return `.number(${swiftNumber(value, 'Double')})`;
}

/** Swift literal for a range. */
function swiftRange({ minimum, maximum, multipleOf }) {
  return `VocabularyRange(minimum: ${swiftNumber(minimum, 'Double')}, maximum: ${swiftNumber(maximum, 'Double')}, multipleOf: ${swiftNumber(multipleOf, 'Double')})`;
}

// The list whose ids the method field rules name (checkFieldRules reads `brew.methods`).
const METHODS_NAMESPACE = 'methods';

/**
 * The Swift `BrewField` cases: the BrewParameters fields but `method`, and
 * the rules keyed by them. Undefined when the version has no field rules.
 * Throws on a rule checkFieldRules rejects (an unknown method or field, ...).
 */
function describeBrewFields(files, fieldRules, brewFields, lists) {
  if (fieldRules === undefined) return undefined;
  if (!Array.isArray(brewFields)) {
    throw new Error(`brew.json has ${FIELD_RULES_KEY}; generateSwift needs brewFields, the BrewParameters fields of openapi.yaml`);
  }
  const problems = checkFieldRules(files, { fields: brewFields });
  if (problems.length > 0) throw new Error(`vocabulary problems:\n${problems.join('\n')}`);
  if (!lists.some((l) => l.namespace === METHODS_NAMESPACE)) throw new Error(`${FIELD_RULES_KEY} needs the list ${METHODS_NAMESPACE}`);
  const fields = brewFields.filter((field) => field !== METHOD_FIELD).map((field) => ({ field, member: swiftMember(field) }));
  if (new Set(fields.map((f) => f.member)).size !== fields.length) throw new Error('two BrewParameters fields become the same Swift case');
  const known = new Set(fields.map((f) => f.field));
  const scaledBy = new Map();
  for (const [field, { by, list }] of Object.entries(SCALED_FIELDS)) {
    if (!known.has(field)) continue;
    if (!known.has(by)) throw new Error(`BrewField ${field} lies on the scale picked in ${by}, which is not a BrewParameters field`);
    if (!(list in ENTRY_RANGES) || !lists.some((l) => l.namespace === list)) {
      throw new Error(`BrewField ${field} lies on a range of the list ${list}, which this version does not define`);
    }
    scaledBy.set(field, by);
  }
  return { fields, rules: fieldRules, scaledBy };
}

/**
 * The Swift source for one vocabulary version and its label languages.
 * `brewFields`, the BrewParameters fields of openapi.yaml, is needed only
 * when the version has method field rules (v3 on).
 */
export function generateSwift({ version, files, languages, brewFields }) {
  const referenceProblems = checkParentReferences(files);
  if (referenceProblems.length > 0) throw new Error(`vocabulary problems:\n${referenceProblems.join('\n')}`);
  const rangeProblems = checkEntryRanges(files);
  if (rangeProblems.length > 0) throw new Error(`vocabulary problems:\n${rangeProblems.join('\n')}`);
  const { lists, ranges, constants, fieldRules } = describeVocabulary(files);
  const types = new Map(lists.map((l) => [l.namespace, typeName(l.namespace)]));
  if (new Set(types.values()).size !== types.size) throw new Error('two namespaces map to the same Swift type name');
  const brew = describeBrewFields(files, fieldRules, brewFields, lists);

  const out = [];
  const line = (text = '') => out.push(text);
  line(`// Generated by scripts/generate-ios-vocabulary.mjs from contracts/vocabulary/v${version}/`);
  line('// and contracts/i18n/. Do not edit. Run `node scripts/generate-ios-vocabulary.mjs`.');
  line('');
  line('import Foundation');
  line('');
  line('/// The closed vocabulary the app was built against.');
  line('enum Vocabulary {');
  line(`    /// Vocabulary version, the directory \`v${version}\` bundled with the app.`);
  line(`    static let version = ${version}`);
  line('');
  line('    /// Vocabulary file names without `.json`, as bundled.');
  line(`    static let files: [String] = [${Object.keys(files).sort().map(swiftString).join(', ')}]`);
  line('');
  line('    /// Every id list, by the JSON property that holds it.');
  line('    enum Namespace: String, CaseIterable, Sendable {');
  for (const list of lists) line(`        case ${swiftMember(list.namespace)} = ${swiftString(list.namespace)}`);
  line('');
  line('        /// The vocabulary file that defines this list.');
  line('        var file: String {');
  line('            switch self {');
  for (const list of lists) line(`            case .${swiftMember(list.namespace)}: return ${swiftString(list.file)}`);
  line('            }');
  line('        }');
  line('');
  line('        /// Whether every id of this list also has a question in the language files.');
  line('        var hasQuestions: Bool {');
  line('            switch self {');
  for (const list of lists) {
    line(`            case .${swiftMember(list.namespace)}: return ${QUESTION_NAMESPACES.includes(list.namespace)}`);
  }
  line('            }');
  line('        }');
  line('');
  line('        /// The generated ids of this list, in file order.');
  line('        var generatedIds: [String] {');
  line('            switch self {');
  for (const list of lists) {
    line(`            case .${swiftMember(list.namespace)}: return Vocabulary.${types.get(list.namespace)}.allCases.map(\\.rawValue)`);
  }
  line('            }');
  line('        }');
  line('    }');

  for (const list of lists) {
    const type = types.get(list.namespace);
    const props = attributeProperties(list);
    const childNamespaces = [...new Set(list.items.flatMap((item) => Object.keys(item.children)))];
    const cases = new Map();
    for (const item of list.items) {
      const member = swiftCase(list.namespace, item.id);
      if ([...cases.values()].includes(member)) throw new Error(`${list.namespace}: two ids become case ${member}`);
      cases.set(item.id, member);
    }
    const rangeKey = ENTRY_RANGES[list.namespace];
    for (const key of [...props.map((p) => p.key), ...(rangeKey === undefined ? [] : [rangeKey])]) {
      const name = lowerCamel(key);
      if ([...cases.values()].includes(name)) throw new Error(`${list.namespace}: attribute ${key} clashes with a case`);
    }

    line('');
    line(`    /// \`${list.namespace}\` in ${list.file}.json.`);
    line(`    enum ${type}: String, CaseIterable, Codable, Sendable, VocabularyItem {`);
    line(`        static let namespace: Vocabulary.Namespace = .${swiftMember(list.namespace)}`);
    line('');
    for (const item of list.items) line(`        case ${cases.get(item.id)} = ${swiftString(item.id)}`);

    for (const { key, type: propType, optional, reference } of props) {
      line('');
      if (reference) {
        line(`        /// \`${key}\` of each entry: the entry of this list it belongs to, or nil for a top-level entry.`);
      } else {
        line(`        /// \`${key}\` of each entry.`);
      }
      const swiftType = reference ? `Vocabulary.${type}` : propType;
      line(`        var ${swiftMember(key)}: ${swiftType}${optional ? '?' : ''} {`);
      line('            switch self {');
      for (const item of list.items) {
        let value = 'nil';
        if (key in item.attributes) {
          value = reference ? `.${cases.get(item.attributes[key])}` : swiftScalar(item.attributes[key], propType);
        }
        line(`            case .${cases.get(item.id)}: return ${value}`);
      }
      line('            }');
      line('        }');
    }

    if (rangeKey !== undefined) {
      line('');
      line(`        /// \`${rangeKey}\` of each entry: its own range, or nil if it has none.`);
      line(`        var ${swiftMember(rangeKey)}: VocabularyRange? {`);
      line('            switch self {');
      for (const item of list.items) {
        const range = item.ranges[rangeKey];
        if (range !== undefined && !isExactStep(range.multipleOf)) {
          throw new Error(`${list.namespace}.${item.id}: ${rangeKey} step ${range.multipleOf} is not exact in binary floating point (ADR 0004)`);
        }
        line(`            case .${cases.get(item.id)}: return ${range === undefined ? 'nil' : swiftRange(range)}`);
      }
      line('            }');
      line('        }');
    }

    for (const childNs of childNamespaces) {
      const childType = types.get(childNs);
      const childList = lists.find((l) => l.namespace === childNs);
      const childCases = new Map(childList.items.map((i) => [i.id, swiftCase(childNs, i.id)]));
      line('');
      line(`        /// The \`${childNs}\` listed under each entry, in file order.`);
      line(`        var ${swiftMember(childNs)}: [Vocabulary.${childType}] {`);
      line('            switch self {');
      for (const item of list.items) {
        const ids = item.children[childNs] ?? [];
        line(`            case .${cases.get(item.id)}: return [${ids.map((id) => `.${childCases.get(id)}`).join(', ')}]`);
      }
      line('            }');
      line('        }');
    }

    if (list.parent !== undefined) {
      const parentList = lists.find((l) => l.namespace === list.parent);
      const parentType = types.get(list.parent);
      const parentName = swiftMember(singular(list.parent));
      line('');
      line(`        /// The \`${list.parent}\` entry this entry is listed under.`);
      line(`        var ${parentName}: Vocabulary.${parentType} {`);
      line('            switch self {');
      for (const item of list.items) {
        const owner = parentList.items.find((p) => (p.children[list.namespace] ?? []).includes(item.id));
        line(`            case .${cases.get(item.id)}: return .${swiftCase(list.parent, owner.id)}`);
      }
      line('            }');
      line('        }');
    }
    line('    }');
  }

  if (brew !== undefined) {
    line('');
    line('    /// The fields of the API\'s BrewParameters (contracts/openapi.yaml) but `method`,');
    line(`    /// which \`${FIELD_RULES_KEY}\` in brew.json can rule. The raw value is the API property.`);
    line('    enum BrewField: String, CaseIterable, Codable, Sendable {');
    for (const { field, member } of brew.fields) line(`        case ${member} = ${swiftString(field)}`);
    line('');
    line('        /// For a field whose value lies on the range of the entry picked in another');
    line('        /// field (`grind_setting` on the `scale` of the `grinder`): that field.');
    line('        var scaledBy: Vocabulary.BrewField? {');
    line('            switch self {');
    for (const { field, member } of brew.fields) {
      const by = brew.scaledBy.get(field);
      line(`            case .${member}: return ${by === undefined ? 'nil' : `.${swiftMember(by)}`}`);
    }
    line('            }');
    line('        }');
    line('    }');
  }

  line('');
  line('    /// Every numeric range, as `{ minimum, maximum, multipleOf }` with inclusive bounds.');
  line('    enum Ranges {');
  for (const range of ranges) {
    line(`        /// ${range.path}`);
    line(
      `        static let ${swiftMember(range.name)} = VocabularyRange(minimum: ${swiftNumber(range.minimum, 'Double')}, ` +
        `maximum: ${swiftNumber(range.maximum, 'Double')}, multipleOf: ${swiftNumber(range.multipleOf, 'Double')})`,
    );
  }
  line('');
  line('        /// Every range by its JSON path, `<file>.<key>...`.');
  line('        static let all: [String: VocabularyRange] = [');
  for (const range of ranges) line(`            ${swiftString(range.path)}: ${swiftMember(range.name)},`);
  line('        ]');
  line('    }');

  line('');
  line('    /// Every other single value in the vocabulary files.');
  line('    enum Constants {');
  for (const constant of constants) {
    const type = scalarType(constant.value);
    line(`        /// ${constant.path}`);
    line(`        static let ${swiftMember(constant.name)}: ${type} = ${swiftScalar(constant.value, type)}`);
  }
  line('');
  line('        /// Every constant by its JSON path, `<file>.<key>...`.');
  line('        static let all: [String: JSONValue] = [');
  for (const constant of constants) line(`            ${swiftString(constant.path)}: ${jsonValueLiteral(constant.value)},`);
  line('        ]');
  line('    }');
  line('}');
  if (brew !== undefined) {
    const methodType = types.get(METHODS_NAMESPACE);
    const methodCase = (id) => `.${swiftCase(METHODS_NAMESPACE, id)}`;
    const fieldMember = new Map(brew.fields.map(({ field, member }) => [field, member]));
    line('');
    line(`extension Vocabulary.${methodType} {`);
    line(`    /// brew.${FIELD_RULES_KEY}: the methods each ruled field is allowed with, in the order`);
    line('    /// of the method list. A field without a rule is allowed with every method.');
    line(`    static let fieldRules: [Vocabulary.BrewField: [Vocabulary.${methodType}]] = [`);
    for (const { field, methods } of brew.rules) {
      line(`        .${fieldMember.get(field)}: [${methods.map(methodCase).join(', ')}],`);
    }
    line('    ]');
    line('');
    line('    /// Whether this method allows `field`: the brew form shows it, and the API accepts it.');
    line('    func allows(_ field: Vocabulary.BrewField) -> Bool {');
    line('        guard let methods = Self.fieldRules[field] else { return true }');
    line('        return methods.contains(self)');
    line('    }');
    line('');
    line('    /// The fields this method allows, in BrewParameters order.');
    line('    var allowedFields: [Vocabulary.BrewField] {');
    line('        Vocabulary.BrewField.allCases.filter { allows($0) }');
    line('    }');
    line('}');
  }
  line('');
  line('/// The languages of contracts/i18n/. Every vocabulary id has a label in each.');
  line('enum VocabularyLanguage: String, CaseIterable, Sendable {');
  for (const lang of languages) line(`    case ${swiftMember(lang)} = ${swiftString(lang)}`);
  line('');
  line('    /// The language used when the device language has no labels.');
  line(`    static let fallback: VocabularyLanguage = .${swiftMember(languages[0])}`);
  line('}');
  line('');
  return out.join('\n');
}

/** The latest version whose files are all `published`. */
export function latestPublishedVersion(vocabularyDir) {
  const published = listVersions(vocabularyDir).filter((v) => isPublished(loadVocabulary(v, vocabularyDir)));
  if (published.length === 0) throw new Error('no published vocabulary version');
  return published[published.length - 1];
}

/** Problems with the Xcode project's bundling of the vocabulary. */
export function checkProject(projectText, version) {
  const problems = [];
  const wanted = [`../contracts/vocabulary/v${version}`, '../contracts/i18n'];
  for (const path of wanted) {
    const ref = new RegExp(`isa = PBXFileReference; lastKnownFileType = folder; name = [A-Za-z0-9_]+; path = ${path.replace(/[./]/g, '\\$&')}; sourceTree = SOURCE_ROOT;`);
    if (!ref.test(projectText)) problems.push(`project.pbxproj has no folder reference to ${path}`);
  }
  const other = [...projectText.matchAll(/path = \.\.\/contracts\/vocabulary\/v([0-9]+);/g)].map((m) => Number(m[1]));
  for (const v of other) {
    if (v !== version) problems.push(`project.pbxproj bundles vocabulary v${v}, but the Swift types are generated from v${version}`);
  }
  return problems;
}

function main() {
  const check = process.argv.includes('--check');
  const version = latestPublishedVersion();
  const files = loadVocabulary(version);
  const i18n = loadI18n();
  const languages = LANGUAGES.filter((lang) => lang in i18n);
  if (languages.length !== LANGUAGES.length) throw new Error(`contracts/i18n is missing one of ${LANGUAGES.join(', ')}`);
  const brewFields = brewParameterFields(loadOpenApi());
  const source = generateSwift({ version, files, languages, brewFields });
  const target = relative(root, GENERATED_FILE);

  if (!check) {
    mkdirSync(dirname(GENERATED_FILE), { recursive: true });
    writeFileSync(GENERATED_FILE, source);
    console.log(`generate-ios-vocabulary: wrote ${target} from vocabulary v${version}`);
    return;
  }

  let failed = false;
  let committed;
  try {
    committed = readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    committed = undefined;
  }
  if (committed === undefined) {
    console.error(`generate-ios-vocabulary: FAILED. ${target} is missing. Run \`node scripts/generate-ios-vocabulary.mjs\`.`);
    failed = true;
  } else if (committed !== source) {
    console.error(
      `generate-ios-vocabulary: FAILED. ${target} is out of date with contracts/. ` +
        'Run `node scripts/generate-ios-vocabulary.mjs` and commit the result.',
    );
    failed = true;
  }
  let projectText = '';
  try {
    projectText = readFileSync(PROJECT_FILE, 'utf8');
  } catch {
    console.error(`generate-ios-vocabulary: FAILED. ${relative(root, PROJECT_FILE)} is missing.`);
    failed = true;
  }
  for (const problem of projectText ? checkProject(projectText, version) : []) {
    console.error(`generate-ios-vocabulary: FAILED. ${problem}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`generate-ios-vocabulary: ${target} is up to date with vocabulary v${version}, and the project bundles it`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

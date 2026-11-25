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
  LANGUAGES,
  QUESTION_NAMESPACES,
  collectIds,
  listVersions,
  loadI18n,
  loadVocabulary,
} from '../contracts/lib/vocabulary.mjs';
import { isPublished } from '../contracts/lib/lock.mjs';

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
const RESERVED_MEMBERS = new Set(['rawValue', 'allCases', 'id', 'namespace', 'hashValue', 'type', 'self']);
// Type names the generator itself uses inside `enum Vocabulary`.
const RESERVED_TYPES = new Set(['Namespace', 'Ranges', 'Constants', 'Language']);
const RANGE_KEYS = ['maximum', 'minimum', 'multipleOf'];
const TOP_LEVEL_META = new Set(['version', 'status']);

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
 * `processes` -> `process`, `criteria` -> `criterion`. A name that does not
 * end in a known plural stays as it is (`water_temp_special`).
 */
export function singular(snake) {
  const parts = snake.split('_');
  const last = parts.pop();
  let one = last;
  if (last === 'criteria') one = 'criterion';
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
 * `{ lists, ranges, constants }`.
 * - lists: `{ namespace, file, items: [{ id, attributes, children }], parent }`
 *   in file order; `children` maps a nested namespace to its ids.
 * - ranges: `{ path, name, minimum, maximum, multipleOf }` for every object
 *   that is exactly `{ minimum, maximum, multipleOf }`.
 * - constants: `{ path, name, value }` for every other scalar outside a list
 *   (top-level `version` and `status` excepted).
 * Throws on anything it cannot represent, so a new shape in vocabulary v<N>
 * fails here instead of being dropped silently.
 */
export function describeVocabulary(files) {
  const { problems } = collectIds(files);
  if (problems.length > 0) throw new Error(`vocabulary problems:\n${problems.join('\n')}`);

  const lists = [];
  const ranges = [];
  const constants = [];

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
      const entry = { id: item.id, attributes: {}, children: {} };
      list.items.push(entry);
      for (const [key, value] of Object.entries(item)) {
        if (key === 'id') continue;
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
  return { lists, ranges, constants };
}

function typeName(namespace) {
  const name = upperCamel(singular(namespace));
  if (RESERVED_TYPES.has(name)) throw new Error(`namespace ${namespace} would become the reserved type name ${name}`);
  return name;
}

function attributeProperties(list) {
  const props = {};
  for (const item of list.items) {
    for (const [key, value] of Object.entries(item.attributes)) {
      const merged = mergeType(props[key], scalarType(value));
      if (merged === null) throw new Error(`${list.namespace}: attribute ${key} mixes types`);
      props[key] = merged;
    }
  }
  return Object.entries(props).map(([key, type]) => ({
    key,
    type,
    optional: list.items.some((item) => !(key in item.attributes)),
  }));
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

/** The Swift source for one vocabulary version and its label languages. */
export function generateSwift({ version, files, languages }) {
  const { lists, ranges, constants } = describeVocabulary(files);
  const types = new Map(lists.map((l) => [l.namespace, typeName(l.namespace)]));
  if (new Set(types.values()).size !== types.size) throw new Error('two namespaces map to the same Swift type name');

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
      const member = swiftMember(item.id);
      if ([...cases.values()].includes(member)) throw new Error(`${list.namespace}: two ids become case ${member}`);
      cases.set(item.id, member);
    }
    for (const { key } of props) {
      const name = lowerCamel(key);
      if ([...cases.values()].includes(name)) throw new Error(`${list.namespace}: attribute ${key} clashes with a case`);
    }

    line('');
    line(`    /// \`${list.namespace}\` in ${list.file}.json.`);
    line(`    enum ${type}: String, VocabularyItem {`);
    line(`        static let namespace: Vocabulary.Namespace = .${swiftMember(list.namespace)}`);
    line('');
    for (const item of list.items) line(`        case ${cases.get(item.id)} = ${swiftString(item.id)}`);

    for (const { key, type: propType, optional } of props) {
      line('');
      line(`        /// \`${key}\` of each entry.`);
      line(`        var ${swiftMember(key)}: ${propType}${optional ? '?' : ''} {`);
      line('            switch self {');
      for (const item of list.items) {
        const value = key in item.attributes ? swiftScalar(item.attributes[key], propType) : 'nil';
        line(`            case .${cases.get(item.id)}: return ${value}`);
      }
      line('            }');
      line('        }');
    }

    for (const childNs of childNamespaces) {
      const childType = types.get(childNs);
      const childList = lists.find((l) => l.namespace === childNs);
      const childCases = new Map(childList.items.map((i) => [i.id, swiftMember(i.id)]));
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
        line(`            case .${cases.get(item.id)}: return .${swiftMember(owner.id)}`);
      }
      line('            }');
      line('        }');
    }
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
  const source = generateSwift({ version, files, languages });
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

// Loading and checking of the closed vocabulary and its labels.
// Every check is a pure function that returns a list of problem strings
// (empty means ok), so tests can feed broken fixtures to the same code
// that guards the real files.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VOCABULARY_DIR = join(CONTRACTS_DIR, 'vocabulary');
export const SCHEMA_DIR = join(VOCABULARY_DIR, 'schema');
export const I18N_DIR = join(CONTRACTS_DIR, 'i18n');

export const LANGUAGES = ['en', 'de'];
export const ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
// Lists whose ids carry a question in addition to a label (spec F3).
export const QUESTION_NAMESPACES = ['criteria'];

const SCHEMA_SUFFIX = '.schema.json';
const SHARED_SCHEMA = 'common';

function readJsonDir(dir, suffix) {
  const out = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(suffix)) continue;
    out[file.slice(0, -suffix.length)] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return out;
}

/** Version numbers that have a `v<N>` directory, ascending. */
export function listVersions(vocabularyDir = VOCABULARY_DIR) {
  return readdirSync(vocabularyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v[1-9][0-9]*$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(1)))
    .sort((a, b) => a - b);
}

/**
 * Problems with the entries of one `v<N>/` directory. Only regular files
 * named `<name>.json` with a snake_case name belong there: a subdirectory,
 * a symlink, a hidden file or any other file name is a problem, so nothing
 * can sit in a version without being checked.
 */
export function checkVersionEntries(version, vocabularyDir = VOCABULARY_DIR) {
  const problems = [];
  const dir = join(vocabularyDir, `v${version}`);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const isVocabularyFile =
      entry.isFile() && entry.name.endsWith('.json') && ID_PATTERN.test(entry.name.slice(0, -'.json'.length));
    if (!isVocabularyFile) problems.push(`v${version}/${entry.name}: unexpected entry, only <name>.json files belong here`);
  }
  return problems.sort();
}

/**
 * `{ <file name without .json>: parsed content }` for one version.
 * Throws if the directory holds anything but vocabulary files.
 */
export function loadVocabulary(version, vocabularyDir = VOCABULARY_DIR) {
  const problems = checkVersionEntries(version, vocabularyDir);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return readJsonDir(join(vocabularyDir, `v${version}`), '.json');
}

/** `{ <name>: schema }`, including the shared `common` definitions. */
export function loadSchemas(schemaDir = SCHEMA_DIR) {
  return readJsonDir(schemaDir, SCHEMA_SUFFIX);
}

/** `{ <lang>: parsed content }` for every language file. */
export function loadI18n(i18nDir = I18N_DIR) {
  return readJsonDir(i18nDir, '.json');
}

/**
 * Validates every vocabulary file against the schema of the same name.
 * A file without a schema, and a schema without a file, are problems.
 */
export function validateVocabulary(files, schemas, expectedVersion) {
  const problems = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);

  for (const [name, content] of Object.entries(files)) {
    const schema = name === SHARED_SCHEMA ? undefined : schemas[name];
    if (!schema) {
      problems.push(`${name}.json: no schema ${name}${SCHEMA_SUFFIX}`);
      continue;
    }
    const validate = ajv.getSchema(schema.$id);
    if (!validate(content)) {
      for (const error of validate.errors) {
        problems.push(`${name}.json: ${error.instancePath || '/'} ${error.message}`);
      }
      continue;
    }
    if (expectedVersion !== undefined && content.version !== expectedVersion) {
      problems.push(`${name}.json: version ${content.version} does not match directory v${expectedVersion}`);
    }
  }
  for (const name of Object.keys(schemas)) {
    if (name !== SHARED_SCHEMA && !(name in files)) {
      problems.push(`${name}${SCHEMA_SUFFIX}: no vocabulary file ${name}.json`);
    }
  }
  return problems;
}

/**
 * Finds every id list in the vocabulary. Every array in a vocabulary file
 * must be an id list: a non-empty array of objects that each carry an `id`.
 * Its namespace is the property name that holds it. Nested lists (flavour
 * notes inside categories) are merged per namespace.
 * Returns `{ lists: { <namespace>: [ids in file order] }, problems }`.
 * Problems: an array that is not an id list (empty, nested arrays, strings,
 * numbers, or objects without `id`), a namespace defined in two files,
 * a duplicate id in a namespace, an id that is not lowercase snake_case.
 */
export function collectIds(files) {
  const lists = {};
  const owner = {};
  const problems = [];
  const isIdItem = (item) => item !== null && typeof item === 'object' && !Array.isArray(item) && 'id' in item;

  const walk = (value, fileName, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, fileName, `${path}/${index}`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if (Array.isArray(child) && (child.length === 0 || !child.every(isIdItem))) {
        problems.push(`${fileName}.json: ${childPath} is not a list of objects with an id`);
        walk(child, fileName, childPath);
        continue;
      }
      if (Array.isArray(child)) {
        if (owner[key] !== undefined && owner[key] !== fileName) {
          problems.push(`${key}: defined in both ${owner[key]}.json and ${fileName}.json`);
        }
        owner[key] = fileName;
        lists[key] ??= [];
        for (const item of child) {
          if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
            problems.push(`${key}: id ${JSON.stringify(item.id)} is not lowercase snake_case`);
          } else if (lists[key].includes(item.id)) {
            problems.push(`${key}: duplicate id ${item.id}`);
          } else {
            lists[key].push(item.id);
          }
        }
      }
      walk(child, fileName, childPath);
    }
  };

  for (const [fileName, content] of Object.entries(files)) {
    if (Array.isArray(content)) problems.push(`${fileName}.json: top level is an array, not an object`);
    walk(content, fileName, '');
  }
  return { lists, problems };
}

/** Union of the id lists of several versions (ids are never reused). */
export function mergeIdLists(listsPerVersion) {
  const merged = {};
  for (const lists of listsPerVersion) {
    for (const [namespace, ids] of Object.entries(lists)) {
      merged[namespace] ??= [];
      for (const id of ids) if (!merged[namespace].includes(id)) merged[namespace].push(id);
    }
  }
  return merged;
}

function checkTextMap(kind, lang, expected, actual, problems) {
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(actual)) {
    problems.push(`${lang}: ${kind} is missing or not an object`);
    return;
  }
  for (const [namespace, ids] of Object.entries(expected)) {
    const texts = isMap(actual[namespace]) ? actual[namespace] : {};
    for (const id of ids) {
      const text = texts[id];
      if (text === undefined) {
        problems.push(`${lang}: missing ${kind} ${namespace}.${id}`);
      } else if (typeof text !== 'string' || text.trim() === '') {
        problems.push(`${lang}: empty ${kind} ${namespace}.${id}`);
      }
    }
  }
  for (const [namespace, texts] of Object.entries(actual)) {
    if (!(namespace in expected)) {
      problems.push(`${lang}: orphan ${kind} namespace ${namespace}`);
      continue;
    }
    if (!isMap(texts)) {
      problems.push(`${lang}: ${kind} ${namespace} is not an object`);
      continue;
    }
    for (const id of Object.keys(texts)) {
      if (!expected[namespace].includes(id)) problems.push(`${lang}: orphan ${kind} ${namespace}.${id}`);
    }
  }
}

/**
 * Checks one language file against the id lists: every id has a non-empty
 * label, every id in QUESTION_NAMESPACES has a non-empty question, and
 * nothing is labelled that the vocabulary does not define.
 */
export function checkI18n(lang, i18n, lists) {
  const problems = [];
  if (i18n === null || typeof i18n !== 'object') return [`${lang}: language file is missing`];
  if (i18n.language !== lang) problems.push(`${lang}: "language" is ${JSON.stringify(i18n.language)}`);
  for (const key of Object.keys(i18n)) {
    if (!['language', 'labels', 'questions'].includes(key)) problems.push(`${lang}: unknown key ${key}`);
  }
  checkTextMap('label', lang, lists, i18n.labels, problems);
  const questionLists = Object.fromEntries(QUESTION_NAMESPACES.map((ns) => [ns, lists[ns] ?? []]));
  checkTextMap('question', lang, questionLists, i18n.questions, problems);
  return problems;
}

/**
 * Checks that go beyond shape: ranges are consistent with their step,
 * bag sizes are distinct, price bands tile the axis without gap or overlap,
 * and all files of one version share one status (draft or published).
 */
export function checkSemantics(files) {
  const problems = [];
  const onStep = (span, step) => Math.abs(span / step - Math.round(span / step)) < 1e-9;

  const ranges = { ...(files.brew?.ranges ?? {}) };
  if (files.criteria?.scale) ranges.scale = files.criteria.scale;
  for (const [name, range] of Object.entries(ranges)) {
    if (!(range.minimum < range.maximum)) problems.push(`range ${name}: minimum is not below maximum`);
    else if (!onStep(range.maximum - range.minimum, range.multipleOf) || !onStep(range.minimum, range.multipleOf)) {
      problems.push(`range ${name}: minimum and maximum are not on the step ${range.multipleOf}`);
    }
  }

  const grams = (files.shelf?.bag_sizes ?? []).map((size) => size.grams);
  if (new Set(grams).size !== grams.length) problems.push('bag_sizes: duplicate grams value');

  const bands = files.shelf?.price_bands ?? [];
  bands.forEach((band, index) => {
    const last = index === bands.length - 1;
    if (index === 0 && band.minimum !== 0) problems.push(`price_bands: first band ${band.id} does not start at 0`);
    if (last && band.maximum_exclusive !== undefined) problems.push(`price_bands: last band ${band.id} must be open-ended`);
    if (!last) {
      if (!(band.maximum_exclusive > band.minimum)) problems.push(`price_bands: band ${band.id} is empty or open-ended`);
      if (band.maximum_exclusive !== bands[index + 1].minimum) {
        problems.push(`price_bands: gap or overlap between ${band.id} and ${bands[index + 1].id}`);
      }
    }
  });

  const statuses = new Set(Object.values(files).map((file) => file.status));
  if (statuses.size > 1) problems.push('status: files of one version must share one status');
  return problems;
}

// Tests for scripts/generate-ios-vocabulary.mjs and scripts/check-ios-strings.mjs.
// Run: node --test scripts/ios-scripts.test.mjs (needs `npm ci` in contracts/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGUAGES, loadVocabulary } from '../contracts/lib/vocabulary.mjs';
import {
  GENERATED_FILE,
  PROJECT_FILE,
  checkProject,
  describeVocabulary,
  generateSwift,
  latestPublishedVersion,
  lowerCamel,
  singular,
  swiftMember,
  swiftString,
  upperCamel,
} from './generate-ios-vocabulary.mjs';
import { checkCatalog, checkKeys, keysInL10n, literalUiStrings } from './check-ios-strings.mjs';

const fixture = (extra = {}) => ({
  brew: {
    version: 9,
    status: 'published',
    methods: [{ id: 'pour_over' }, { id: 'v60' }],
    ranges: { dose_g: { minimum: 5, maximum: 100, multipleOf: 0.1 } },
    ...extra,
  },
});

test('names: snake_case to Swift', () => {
  assert.equal(lowerCamel('from_15_to_30'), 'from15To30');
  assert.equal(lowerCamel('g_250'), 'g250');
  assert.equal(upperCamel('flavour_categories'), 'FlavourCategories');
  assert.equal(singular('methods'), 'method');
  assert.equal(singular('flavour_categories'), 'flavour_category');
  assert.equal(singular('processes'), 'process');
  assert.equal(singular('criteria'), 'criterion');
  assert.equal(singular('water_temp_special'), 'water_temp_special');
  assert.equal(singular('varieties'), 'variety');
  assert.equal(swiftMember('default'), '`default`');
  assert.throws(() => swiftMember('raw_value'), /reserved/);
  assert.equal(swiftString('a"b\\c\n'), '"a\\"b\\\\c\\n"');
});

test('describeVocabulary finds lists, nested lists, ranges and constants', () => {
  const files = fixture({
    max_picks: 3,
    groups: [
      { id: 'g1', items: [{ id: 'a' }, { id: 'b' }] },
      { id: 'g2', items: [{ id: 'c', grams: 2 }] },
    ],
  });
  const { lists, ranges, constants } = describeVocabulary(files);
  assert.deepEqual(
    lists.map((l) => [l.namespace, l.items.map((i) => i.id), l.parent]),
    [
      ['methods', ['pour_over', 'v60'], undefined],
      ['groups', ['g1', 'g2'], undefined],
      ['items', ['a', 'b', 'c'], 'groups'],
    ],
  );
  assert.deepEqual(ranges, [{ path: 'brew.ranges.dose_g', name: 'doseG', minimum: 5, maximum: 100, multipleOf: 0.1 }]);
  assert.deepEqual(constants, [{ path: 'brew.max_picks', name: 'maxPicks', value: 3 }]);
});

test('describeVocabulary rejects what the contract rules reject', () => {
  assert.throws(() => describeVocabulary(fixture({ methods: [{ id: 'a' }, { id: 'a' }] })), /duplicate id/);
  assert.throws(() => describeVocabulary(fixture({ tags: ['a'] })), /not a list of objects with an id/);
  assert.throws(() => describeVocabulary(fixture({ methods: [{ id: 'a', meta: { x: 1 } }] })), /neither a scalar nor an id list/);
});

test('generateSwift writes enums with raw values equal to the ids', () => {
  const swift = generateSwift({ version: 9, files: fixture(), languages: ['en', 'de'] });
  assert.match(swift, /enum Method: String, CaseIterable, Codable, Sendable, VocabularyItem \{/);
  assert.match(swift, /case pourOver = "pour_over"/);
  assert.match(swift, /case v60 = "v60"/);
  assert.match(swift, /static let doseG = VocabularyRange\(minimum: 5\.0, maximum: 100\.0, multipleOf: 0\.1\)/);
  assert.match(swift, /static let fallback: VocabularyLanguage = \.en/);
  assert.match(swift, /static let version = 9/);
});

test('generateSwift output changes when an id is added (the drift check can see it)', () => {
  const before = generateSwift({ version: 9, files: fixture(), languages: ['en'] });
  const after = generateSwift({
    version: 9,
    files: fixture({ methods: [{ id: 'pour_over' }, { id: 'v60' }, { id: 'siphon' }] }),
    languages: ['en'],
  });
  assert.notEqual(before, after);
  assert.match(after, /case siphon = "siphon"/);
});

test('the committed Vocabulary.swift matches the latest published vocabulary', () => {
  const version = latestPublishedVersion();
  const fresh = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES });
  assert.equal(readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n'), fresh);
});

test('checkProject requires folder references to the generated version and i18n', () => {
  assert.deepEqual(checkProject(readFileSync(PROJECT_FILE, 'utf8'), latestPublishedVersion()), []);
  const ref = (path) => `{isa = PBXFileReference; lastKnownFileType = folder; name = x; path = ${path}; sourceTree = SOURCE_ROOT; };`;
  const both = `${ref('../contracts/vocabulary/v1')}\n${ref('../contracts/i18n')}`;
  assert.deepEqual(checkProject(both, 1), []);
  assert.equal(checkProject(both, 2).length, 2);
  assert.equal(checkProject(ref('../contracts/vocabulary/v1'), 1).length, 1);
});

const unit = (value, state = 'translated') => ({ stringUnit: { state, value } });

test('checkCatalog accepts a complete catalog and names each gap', () => {
  const ok = { sourceLanguage: 'en', strings: { 'a.b': { localizations: { en: unit('A'), de: unit('A de') } } } };
  assert.deepEqual(checkCatalog(ok, ['en', 'de']), []);
  const bad = {
    sourceLanguage: 'de',
    strings: {
      missing: { localizations: { en: unit('A') } },
      empty: { localizations: { en: unit('A'), de: unit(' ') } },
      fresh: { localizations: { en: unit('A'), de: unit('B', 'new') } },
      extra: { localizations: { en: unit('A'), de: unit('B'), fr: unit('C') } },
    },
  };
  const problems = checkCatalog(bad, ['en', 'de']);
  assert.equal(problems.length, 5, problems.join('\n'));
});

test('keysInL10n and checkKeys find missing and orphan keys', () => {
  const source = `enum L10n {\n    static var a: LocalizedStringKey { "a.one" }\n    static var b: LocalizedStringKey { "b.two" }\n}`;
  assert.deepEqual(keysInL10n(source), ['a.one', 'b.two']);
  assert.deepEqual(checkKeys(['a.one'], ['a.one']), []);
  assert.equal(checkKeys(['a.one', 'b.two'], ['a.one', 'c.three']).length, 2);
});

test('literalUiStrings flags literals and allows keys and verbatim labels', () => {
  const source = [
    'Text("Hello")',
    'Text(L10n.appTitle)',
    'Text(verbatim: label)',
    '.navigationTitle("Title")',
    '// Text("in a comment")',
  ].join('\n');
  assert.deepEqual(literalUiStrings(source), [
    { line: 1, call: 'Text' },
    { line: 4, call: 'navigationTitle' },
  ]);
});

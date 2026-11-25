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
  listSubject,
  lowerCamel,
  singular,
  swiftCase,
  swiftMember,
  swiftString,
  upperCamel,
} from './generate-ios-vocabulary.mjs';
import { checkCatalog, checkKeys, keysInL10n, lexSwift, literalBindings, literalUiStrings } from './check-ios-strings.mjs';

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

test('ids that look like Optional cases get a Swift case named after their list', () => {
  assert.equal(listSubject('milk_types'), 'Milk');
  assert.equal(listSubject('methods'), 'Method');
  assert.equal(listSubject('water_temp_special'), 'WaterTempSpecial');
  assert.equal(swiftCase('milk_types', 'none'), 'noMilk');
  assert.equal(swiftCase('methods', 'none'), 'noMethod');
  assert.equal(swiftCase('grind_kinds', 'some'), 'someGrind');
  assert.equal(swiftCase('milk_types', 'oat'), 'oat');
  assert.equal(swiftCase('milk_types', 'other_plant'), 'otherPlant');
  assert.equal(swiftCase('milk_types', 'default'), '`default`');
});

test('generateSwift renames none to noMilk and keeps the raw value', () => {
  const files = fixture({ milk_types: [{ id: 'none' }, { id: 'oat' }] });
  const swift = generateSwift({ version: 9, files, languages: ['en'] });
  assert.match(swift, /case noMilk = "none"/);
  assert.doesNotMatch(swift, /case `?none`?\b/);
  // A clash with the renamed case is caught, not emitted twice.
  const clash = fixture({ milk_types: [{ id: 'none' }, { id: 'no_milk' }] });
  assert.throws(() => generateSwift({ version: 9, files: clash, languages: ['en'] }), /two ids become case noMilk/);
});

test('generateSwift uses the renamed case for parents and children too', () => {
  const files = fixture({ groups: [{ id: 'none', notes: [{ id: 'some' }] }] });
  const swift = generateSwift({ version: 9, files, languages: ['en'] });
  assert.match(swift, /case noGroup = "none"/);
  assert.match(swift, /case someNote = "some"/);
  assert.match(swift, /case \.noGroup: return \[\.someNote\]/);
  assert.match(swift, /case \.someNote: return \.noGroup/);
  assert.doesNotMatch(swift, /\.(none|some)\b/);
});

test('no generated case of the real vocabulary is none or some', () => {
  const version = latestPublishedVersion();
  const swift = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES });
  assert.doesNotMatch(swift, /^\s*case `?(none|some)`?\b/m);
  assert.doesNotMatch(swift, /\.(none|some)\b/);
  assert.match(swift, /case noMilk = "none"/);
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
const entry = (localizations) => ({ extractionState: 'manual', localizations });

test('checkCatalog accepts a complete catalog and names each gap', () => {
  const ok = { sourceLanguage: 'en', strings: { 'a.b': entry({ en: unit('A'), de: unit('A de') }) } };
  assert.deepEqual(checkCatalog(ok, ['en', 'de']), []);
  const bad = {
    sourceLanguage: 'de',
    strings: {
      missing: entry({ en: unit('A') }),
      empty: entry({ en: unit('A'), de: unit(' ') }),
      fresh: entry({ en: unit('A'), de: unit('B', 'new') }),
      extra: entry({ en: unit('A'), de: unit('B'), fr: unit('C') }),
    },
  };
  const problems = checkCatalog(bad, ['en', 'de']);
  assert.equal(problems.length, 5, problems.join('\n'));
});

test('checkCatalog requires extractionState manual on every entry', () => {
  const both = { en: unit('A'), de: unit('A de') };
  const catalog = (extra) => ({ sourceLanguage: 'en', strings: { 'a.b': { ...extra, localizations: both } } });
  assert.deepEqual(checkCatalog(catalog({ extractionState: 'manual' }), ['en', 'de']), []);
  for (const state of [undefined, 'stale', 'extracted_with_value', 'migrated']) {
    const problems = checkCatalog(catalog(state === undefined ? {} : { extractionState: state }), ['en', 'de']);
    assert.equal(problems.length, 1, `${state}: ${problems.join('; ')}`);
    assert.match(problems[0], /a\.b: extractionState is .*, expected "manual"/);
  }
});

test('the committed catalog is valid JSON with extractionState manual everywhere', () => {
  const catalog = JSON.parse(readFileSync(new URL('../ios/Cupmark/Localizable.xcstrings', import.meta.url), 'utf8'));
  assert.ok(Object.keys(catalog.strings).length > 0);
  assert.deepEqual(checkCatalog(catalog), []);
  for (const [key, value] of Object.entries(catalog.strings)) assert.equal(value.extractionState, 'manual', key);
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
    { line: 1, call: 'Text', reason: 'literal' },
    { line: 4, call: 'navigationTitle', reason: 'literal' },
  ]);
});

test('literalUiStrings flags Text(verbatim:) with a literal, also inside a fallback', () => {
  assert.deepEqual(literalUiStrings('Text(verbatim: "Hello")'), [{ line: 1, call: 'Text', reason: 'verbatim' }]);
  assert.deepEqual(literalUiStrings('Text(verbatim:"Hello")'), [{ line: 1, call: 'Text', reason: 'verbatim' }]);
  assert.deepEqual(literalUiStrings('Text(verbatim: #"Raw"#)'), [{ line: 1, call: 'Text', reason: 'verbatim' }]);
  assert.deepEqual(literalUiStrings('Text(verbatim: (try? store.label(for: m, language: l)) ?? "n/a")'), [
    { line: 1, call: 'Text', reason: 'verbatim' },
  ]);
  // The current RootView form: a store label with a rawValue fallback.
  assert.deepEqual(literalUiStrings('Text(verbatim: (try? store.label(for: method, language: language)) ?? method.rawValue)'), []);
});

test('literalUiStrings flags a literal on a later line than the call', () => {
  const source = ['VStack {', '    Text(', '        "Hello"', '    )', '    .accessibilityLabel(', '', '"Hi")', '}'].join('\n');
  assert.deepEqual(literalUiStrings(source), [
    { line: 2, call: 'Text', reason: 'literal' },
    { line: 5, call: 'accessibilityLabel', reason: 'literal' },
  ]);
  assert.deepEqual(literalUiStrings('Text(\n    verbatim:\n    "Hello"\n)'), [{ line: 1, call: 'Text', reason: 'verbatim' }]);
  assert.deepEqual(literalUiStrings('Text( // say hi\n "Hello")'), [{ line: 1, call: 'Text', reason: 'literal' }]);
  assert.deepEqual(literalUiStrings('Text(\n"""\nHello\n""")'), [{ line: 1, call: 'Text', reason: 'literal' }]);
});

test('literalUiStrings flags a literal passed through a variable', () => {
  const source = [
    'struct V: View {',
    '    let title = "Hello"',
    '    private var key: LocalizedStringKey = "a.b"',
    '    static let raw: String = #"Raw"#',
    '    var body: some View {',
    '        Text(title)',
    '        Text(verbatim: title)',
    '        Text(self.key)',
    '        Label(raw, systemImage: "star")',
    '        Text(other)',
    '        Text(title.uppercased())',
    '    }',
    '}',
  ].join('\n');
  assert.deepEqual([...literalBindings(lexSwift(source).masked)].sort(), ['key', 'raw', 'title']);
  assert.deepEqual(literalUiStrings(source), [
    { line: 6, call: 'Text', reason: 'variable' },
    { line: 7, call: 'Text', reason: 'variable' },
    { line: 8, call: 'Text', reason: 'variable' },
    { line: 9, call: 'Label', reason: 'variable' },
  ]);
});

test('literalUiStrings allows literals that are not shown text', () => {
  const source = [
    'Image(systemName: "exclamationmark.triangle")',
    'Label(L10n.appTitle, systemImage: "star")',
    'let name = "Localizable"',
    'Text(L10n.appTitle)',
    'Text(verbatim: label)',
    '/* Text("in a block comment") */',
    'let url = "https://example.invalid/a//b"; Text(L10n.appTitle)',
    'let s = "Text(\\"quoted\\")"',
    'Context("x")',
  ].join('\n');
  assert.deepEqual(literalUiStrings(source), []);
});

test('lexSwift blanks comments and string contents but keeps offsets and lines', () => {
  const source = 'a /* x\n /* nested */ y */ "s // t" // c\n#"r"\\"#';
  const { masked, strings } = lexSwift(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(masked, /[xyct]|nested/);
  assert.deepEqual(strings.map(([a, b]) => source.slice(a, b)), ['"s // t"', '#"r"\\"#']);
});

test('the committed iOS sources pass the literal check', () => {
  for (const name of ['RootView.swift', 'CupmarkApp.swift', 'VocabularyLoadState.swift']) {
    const text = readFileSync(new URL(`../ios/Cupmark/${name}`, import.meta.url), 'utf8');
    assert.deepEqual(literalUiStrings(text), [], name);
  }
});

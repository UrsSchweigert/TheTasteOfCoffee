// Tests for scripts/generate-ios-vocabulary.mjs, scripts/generate-ios-api.mjs,
// scripts/check-ios-strings.mjs and the stage configuration in ios/Config (M2-T9).
// Run: node --test scripts/ios-scripts.test.mjs (needs `npm ci` in contracts/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, loadVocabulary } from '../contracts/lib/vocabulary.mjs';
import { loadOpenApi } from '../contracts/lib/openapi.mjs';
import {
  GENERATED_FILE,
  PROJECT_FILE,
  brewParameterFields,
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
import {
  EXCLUDED_OPERATIONS,
  GENERATED_FILE as API_GENERATED_FILE,
  describeApi,
  describeOperations,
  generateSwift as generateApiSwift,
  reachableSchemas,
} from './generate-ios-api.mjs';
import {
  checkCatalog,
  checkInfoPlistCatalog,
  checkKeys,
  keysInL10n,
  lexSwift,
  literalBindings,
  literalUiStrings,
  usageDescriptionSettings,
} from './check-ios-strings.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.equal(singular('species'), 'species');
  assert.equal(singular('origins'), 'origin');
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
  const swift = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES, brewFields: v3BrewFields() });
  assert.doesNotMatch(swift, /^\s*case `?(none|some)`?\b/m);
  assert.doesNotMatch(swift, /\.(none|some)\b/);
  assert.match(swift, /case noMilk = "none"/);
});

test('generateSwift emits a parent reference (country in origins) as a typed, optional entry of the same list', () => {
  const files = {
    bean: {
      version: 9,
      status: 'published',
      origins: [{ id: 'indonesia' }, { id: 'bali', country: 'indonesia' }, { id: 'none' }],
      species: [{ id: 'arabica' }],
    },
  };
  const swift = generateSwift({ version: 9, files, languages: ['en'] });
  assert.match(swift, /enum Origin: String/);
  assert.match(swift, /enum Species: String/);
  assert.match(swift, /var country: Vocabulary\.Origin\? \{/);
  assert.match(swift, /case \.bali: return \.indonesia/);
  assert.match(swift, /case \.indonesia: return nil/);
  assert.match(swift, /case \.noOrigin: return nil/);
  assert.doesNotMatch(swift, /var country: String/);
  // A broken reference fails generation instead of emitting a dangling case.
  const broken = structuredClone(files);
  broken.bean.origins[1].country = 'atlantis';
  assert.throws(() => generateSwift({ version: 9, files: broken, languages: ['en'] }), /country "atlantis" is not an entry of origins/);
  const nested = structuredClone(files);
  nested.bean.origins.push({ id: 'ubud', country: 'bali' });
  assert.throws(() => generateSwift({ version: 9, files: nested, languages: ['en'] }), /has a country itself/);
  // Other scalar attributes stay plain values.
  const plain = generateSwift({ version: 9, files: fixture({ bag_sizes: [{ id: 'g_250', grams: 250 }] }), languages: ['en'] });
  assert.match(plain, /var grams: Int \{/);
});

test('the real vocabulary: Origin.country, Species and Variety, and java in two enums without a clash', () => {
  const version = latestPublishedVersion();
  assert.equal(version, 3);
  const swift = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES, brewFields: v3BrewFields() });
  assert.match(swift, /var country: Vocabulary\.Origin\? \{/);
  for (const region of ['hawaii: return .usa', 'sumatra: return .indonesia', 'java: return .indonesia', 'bali: return .indonesia', 'flores: return .indonesia']) {
    assert.ok(swift.includes(`case .${region}`), region);
  }
  assert.match(swift, /enum Species: String, CaseIterable, Codable, Sendable, VocabularyItem \{/);
  assert.match(swift, /case arabicaRobustaBlend = "arabica_robusta_blend"/);
  assert.match(swift, /enum Variety: String, CaseIterable, Codable, Sendable, VocabularyItem \{/);
  assert.match(swift, /case ethiopia74110 = "ethiopia_74110"/);
  const javaCases = swift.match(/^\s*case java = "java"$/gm) ?? [];
  assert.equal(javaCases.length, 2, 'Origin.java and Variety.java');
  assert.doesNotMatch(swift, /case robusta = "robusta"[\s\S]*enum Variety[\s\S]*case robusta/, 'robusta is a species only');
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
  const brewFields = brewParameterFields(loadOpenApi());
  const fresh = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES, brewFields });
  assert.equal(readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n'), fresh);
});

// ---- Vocabulary v3 (draft, M2-T3): grinders with a scale, and the method field rules. ----

/** The fields v3 added to BrewParameters when it was published (M2-T4). */
const V3_FIELDS = ['grinder', 'grind_setting'];
const v3BrewFields = () => brewParameterFields(loadOpenApi());
const v3Files = () => structuredClone(loadVocabulary(3));
const generateV3 = (files = v3Files(), brewFields = v3BrewFields()) =>
  generateSwift({ version: 3, files, languages: LANGUAGES, brewFields });
/** The body of a generated Swift switch property or table, from its declaration to the next blank line. */
const swiftBlock = (swift, declaration) => {
  const start = swift.indexOf(declaration);
  assert.ok(start >= 0, `no ${declaration}`);
  const end = swift.indexOf('\n\n', start);
  return swift.slice(start, end < 0 ? undefined : end);
};

test('v3 draft: the generator describes it instead of throwing on grinders.<id>.scale', () => {
  const swift = generateV3();
  assert.match(swift, /static let version = 3/);
  assert.match(swift, /enum Grinder: String, CaseIterable, Codable, Sendable, VocabularyItem \{/);
  assert.match(swift, /case grinders = "grinders"/);
  assert.match(swift, /case \.grinders: return "brew"/);
});

test('v3 draft: Grinder.scale is a typed optional range, read from every grinder in the file', () => {
  const swift = generateV3();
  const block = swiftBlock(swift, 'var scale: VocabularyRange? {');
  for (const grinder of loadVocabulary(3).brew.grinders) {
    const member = swiftCase('grinders', grinder.id);
    const value = grinder.scale === undefined
      ? 'nil'
      : `VocabularyRange(minimum: ${grinder.scale.minimum.toFixed(1)}, maximum: ${grinder.scale.maximum.toFixed(1)}, multipleOf: ${grinder.scale.multipleOf.toFixed(1)})`;
    assert.ok(block.includes(`case .${member}: return ${value}\n`), `${grinder.id}: ${value}`);
  }
  assert.match(block, /case \.nicheZero: return VocabularyRange\(minimum: 0\.0, maximum: 50\.0, multipleOf: 0\.5\)/);
  assert.match(block, /case \.preGround: return nil/);
  assert.match(block, /case \.other: return nil/);
  // A scale is no global range and no constant; the scale attribute is not a plain property.
  assert.doesNotMatch(swift, /"brew\.grinders/);
  assert.doesNotMatch(swift, /static let (comandanteC40|nicheZero)/);
});

test('v3 draft: field_rules become a typed method table, never Bool constants', () => {
  const swift = generateV3();
  assert.doesNotMatch(swift, /: Bool = /, 'no Bool constant');
  assert.doesNotMatch(swift, /\.bool\(/, 'no Bool in Constants.all');
  assert.doesNotMatch(swift, /field_rules\./, 'no rule under a JSON path');
  assert.doesNotMatch(swift, /allowedMethods/);
  // The constants of v3 are those of v2: the rules add none.
  const constants = (text) => swiftBlock(text, 'enum Constants {');
  const v2 = generateSwift({ version: 2, files: loadVocabulary(2), languages: LANGUAGES });
  assert.equal(constants(swift), constants(v2));
  // The table holds exactly the file's rules, in file order, as typed cases.
  const table = swiftBlock(swift, 'static let fieldRules: [Vocabulary.BrewField: [Vocabulary.Method]] = [');
  const rules = Object.entries(loadVocabulary(3).brew.field_rules);
  const rows = table.split('\n').slice(1).map((row) => row.trim());
  assert.deepEqual(rows, [
    ...rules.map(([field, rule]) =>
      `.${swiftMember(field)}: [${Object.keys(rule.allowed_methods).map((id) => `.${swiftCase('methods', id)}`).join(', ')}],`),
    ']',
  ]);
  assert.match(swift, /extension Vocabulary\.Method \{/);
  assert.match(swift, /func allows\(_ field: Vocabulary\.BrewField\) -> Bool \{\n {8}guard let methods = Self\.fieldRules\[field\] else \{ return true \}\n {8}return methods\.contains\(self\)/);
  assert.match(swift, /var allowedFields: \[Vocabulary\.BrewField\] \{/);
});

test('v3 draft: BrewField is every BrewParameters field but method, and grind_setting lies on the grinder scale', () => {
  const swift = generateV3();
  const block = swiftBlock(swift, 'enum BrewField: String, CaseIterable, Codable, Sendable {');
  const cases = [...block.matchAll(/^ {8}case (\w+) = "(\w+)"$/gm)].map((m) => m[2]);
  assert.deepEqual(cases, v3BrewFields().filter((field) => field !== 'method'));
  for (const field of ['dose_dg', 'water_temp_c', 'water_temp_special', 'milk', 'grinder', 'grind_setting']) assert.ok(cases.includes(field), field);
  const scaledBy = swiftBlock(swift, 'var scaledBy: Vocabulary.BrewField? {');
  assert.match(scaledBy, /case \.grindSetting: return \.grinder\n/);
  assert.match(scaledBy, /case \.grinder: return nil\n/);
  assert.equal((scaledBy.match(/return \./g) ?? []).length, 1);
});

test('v3 draft: the rules come from the file, so a changed rule changes the output', () => {
  const files = v3Files();
  delete files.brew.field_rules.water_temp_c.allowed_methods.siphon;
  const changed = generateV3(files);
  assert.notEqual(changed, generateV3());
  assert.match(changed, /\.waterTempC: \[\.espresso, \.v60, \.chemex, \.kalita, \.batchFilter, \.aeropress, \.frenchPress, \.fullyAutomatic\],/);
});

test('v3 draft: generation fails on a rule that names an unknown method or field', () => {
  const unknownMethod = v3Files();
  unknownMethod.brew.field_rules.water_temp_special.allowed_methods.turbo_press = true;
  assert.throws(() => generateV3(unknownMethod), /field_rules\.water_temp_special: turbo_press is not a method/);
  const unknownField = v3Files();
  unknownField.brew.field_rules.grind_size = { allowed_methods: { espresso: true } };
  assert.throws(() => generateV3(unknownField), /field_rules\.grind_size: grind_size is not a BrewParameters field/);
  // The fields come from BrewParameters: without the v3 fields the draft does not generate.
  assert.throws(() => generateV3(v3Files(), v3BrewFields().filter((field) => !V3_FIELDS.includes(field))), /grinder is not a BrewParameters field/);
  // Rules need the field list; the method itself is never ruled.
  assert.throws(() => generateSwift({ version: 3, files: v3Files(), languages: LANGUAGES }), /needs brewFields/);
  const methodRule = v3Files();
  methodRule.brew.field_rules.method = { allowed_methods: { espresso: true } };
  assert.throws(() => generateV3(methodRule), /the method is never ruled by a method/);
  // Rules belong at the top of brew.json only.
  const elsewhere = v3Files();
  elsewhere.shelf.field_rules = structuredClone(elsewhere.brew.field_rules);
  assert.throws(() => generateV3(elsewhere), /field rules belong at the top of brew\.json/);
});

test('v3 draft: generation fails on a scale off its step or with an inexact step', () => {
  const offStep = v3Files();
  offStep.brew.grinders.find((g) => g.id === 'comandante_c40').scale.maximum = 50.5;
  assert.throws(() => generateV3(offStep), /grinders\.comandante_c40: scale minimum and maximum are not on the step 1/);
  const inexact = v3Files();
  inexact.brew.grinders.find((g) => g.id === 'niche_zero').scale.multipleOf = 0.1;
  assert.throws(() => generateV3(inexact), /grinders\.niche_zero: scale step 0\.1 is not exact/);
  const notARange = v3Files();
  notARange.brew.grinders[0].scale = { minimum: 0, maximum: 50 };
  assert.throws(() => generateV3(notARange), /comandante_c40: scale is not a range/);
  const unscaled = v3Files();
  unscaled.brew.grinders.find((g) => g.id === 'pre_ground').scale = { minimum: 0, maximum: 10, multipleOf: 1 };
  assert.throws(() => generateV3(unscaled), /pre_ground has no scale/);
  // A scale on an entry of another list is no attribute the generator accepts.
  const otherList = v3Files();
  otherList.brew.methods[0].scale = { minimum: 0, maximum: 10, multipleOf: 1 };
  assert.throws(() => generateV3(otherList), /methods\.espresso: scale is only allowed in grinders/);
});

test('the v3 fields are in BrewParameters, because v3 is published', () => {
  for (const field of V3_FIELDS) assert.ok(brewParameterFields(loadOpenApi()).includes(field), field);
});

test('v2 has no grinders and no rules, so its output is unchanged', () => {
  const swift = generateSwift({ version: 2, files: loadVocabulary(2), languages: LANGUAGES, brewFields: brewParameterFields(loadOpenApi()) });
  assert.equal(swift, generateSwift({ version: 2, files: loadVocabulary(2), languages: LANGUAGES }));
  assert.doesNotMatch(swift, /Grinder|BrewField|fieldRules/);
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
  // String members that look their key up (VoiceOver announcements, M2-T21) count too, in order.
  const withString = `enum L10n {\n    static var a: LocalizedStringKey { "a.one" }\n    static var c: String { String(localized: "c.three") }\n    static var b: LocalizedStringKey { "b.two" }\n}`;
  assert.deepEqual(keysInL10n(withString), ['a.one', 'c.three', 'b.two']);
  const withFormat = `enum L10n {\n    static func d(time: String) -> String { String(localized: "d.four \\(time)") }\n}`;
  assert.deepEqual(keysInL10n(withFormat), ['d.four %@']);
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

// ---- scripts/generate-ios-api.mjs (M2-T7, ADR 0022) ----

const apiFixture = () => ({
  openapi: '3.1.0',
  info: { title: 't', version: '9.8.7' },
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        parameters: [{ $ref: '#/components/parameters/CursorQuery' }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/ThingPage' } } } } },
      },
      post: {
        operationId: 'createThing',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
        responses: { 201: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } }, 400: { description: 'bad' } },
      },
    },
    '/things/{id}': {
      delete: { operationId: 'deleteThing', responses: { 204: { description: 'gone' } } },
    },
    '/picture': {
      get: {
        operationId: 'getPicture',
        responses: { 200: { description: 'ok', content: { 'image/jpeg': { schema: { type: 'string', contentMediaType: 'image/jpeg' } } } } },
      },
    },
    '/health': {
      get: { operationId: 'getHealth', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Unused' } } } } } },
    },
  },
  components: {
    parameters: { CursorQuery: { name: 'cursor', in: 'query', schema: { $ref: '#/components/schemas/Cursor' } } },
    schemas: {
      Cursor: { type: 'string', pattern: '^[a-z]{1,9}$' },
      Unused: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['ok'] } } },
      Day: { type: 'string', format: 'date' },
      Method: { type: 'string', enum: ['pour_over', 'v60'], 'x-vocabulary': 'methods' },
      DoseDg: { type: 'integer', minimum: 50, maximum: 1000, 'x-vocabulary-range': 'brew.ranges.dose_g', 'x-vocabulary-scale': 10 },
      Thing: {
        type: 'object',
        additionalProperties: false,
        required: ['method'],
        properties: {
          method: { $ref: '#/components/schemas/Method' },
          dose_dg: { $ref: '#/components/schemas/DoseDg' },
          note_count: { type: 'integer' },
        },
      },
      ThingPage: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Thing' } }, next_cursor: { $ref: '#/components/schemas/Cursor' } },
      },
    },
  },
});
const apiOptions = { excluded: { getHealth: 'not called' }, groups: [] };
const generateFixture = (doc = apiFixture(), options = apiOptions) =>
  generateApiSwift({ doc, vocabularyVersion: 9, vocabularyFiles: fixture(), options });

test('generate-ios-api: exports the file it writes, under the synchronized app folder', () => {
  assert.equal(relative(repoRoot, API_GENERATED_FILE).split(sep).join('/'), 'ios/Cupmark/Generated/API.swift');
});

test('generate-ios-api: operations, reachable schemas and the excluded health route', () => {
  const doc = apiFixture();
  doc.components.schemas.Day = { type: 'string', format: 'date' }; // unreachable: not emitted
  const ops = describeOperations(doc, apiOptions.excluded);
  assert.deepEqual(ops.map((o) => [o.operationId, o.method, o.successStatus, o.requestSchema, o.responseSchema, o.responseContentType]), [
    ['listThings', 'get', 200, null, 'ThingPage', 'application/json'],
    ['createThing', 'post', 201, 'Thing', 'Thing', 'application/json'],
    ['deleteThing', 'delete', 204, null, null, null],
    ['getPicture', 'get', 200, null, null, 'image/jpeg'],
  ]);
  assert.deepEqual(reachableSchemas(doc, ['ThingPage', 'Cursor']), ['Cursor', 'Method', 'DoseDg', 'Thing', 'ThingPage']);
  const swift = generateFixture(doc);
  assert.doesNotMatch(swift, /Unused|getHealth = |CalendarDate \{|struct Day/);
  assert.match(swift, /case listThings = "listThings"/);
  assert.match(swift, /case \.getPicture: return "image\/jpeg"/);
  assert.match(swift, /case \.deleteThing: return 204/);
  assert.match(swift, /static let contractVersion = "9\.8\.7"/);
  assert.throws(() => describeOperations(doc, { getNothing: 'x' }), /EXCLUDED_OPERATIONS names getNothing/);
});

test('generate-ios-api: vocabulary enums are the Vocabulary types, never a second list', () => {
  const swift = generateFixture();
  assert.match(swift, /var method: Vocabulary\.Method$/m);
  assert.doesNotMatch(swift, /"pour_over"|"v60"/);
  const drift = apiFixture();
  drift.components.schemas.Method.enum = ['pour_over', 'v60', 'siphon'];
  assert.throws(() => generateFixture(drift), /enum differs from methods.*not in the vocabulary: siphon/);
  const unknown = apiFixture();
  unknown.components.schemas.Method['x-vocabulary'] = 'gadgets';
  assert.throws(() => generateFixture(unknown), /x-vocabulary gadgets is not a list/);
});

test('generate-ios-api: dose_dg stays an integer with a grams helper', () => {
  const swift = generateFixture();
  assert.match(swift, /typealias DoseDg = Int$/m);
  assert.match(swift, /var doseDg: API\.DoseDg\?$/m);
  assert.match(swift, /var doseGrams: Double\? \{/);
  assert.match(swift, /API\.scaledInteger\(value, scale: 10\)/);
});

test('generate-ios-api: a list of objects decodes element by element', () => {
  const swift = generateFixture();
  assert.match(swift, /let itemsAttempts = try container\.decode\(\[API\.DecodingAttempt<API\.Thing>\]\.self, forKey: \.items\)/);
  assert.match(swift, /self\.undecodableItems = API\.undecodableItems\(itemsAttempts, property: "items"\)/);
  // Not encoded: CodingKeys hold only the contract's names.
  const page = swift.slice(swift.indexOf('struct ThingPage'));
  const keys = page.slice(page.indexOf('enum CodingKeys'), page.indexOf('}', page.indexOf('enum CodingKeys')));
  assert.deepEqual([...keys.matchAll(/= "([a-z_]+)"/g)].map((m) => m[1]), ['items', 'next_cursor']);
  // A struct without such a list keeps the synthesized Codable.
  const thing = swift.slice(swift.indexOf('struct Thing:'), swift.indexOf('struct ThingPage'));
  assert.doesNotMatch(thing, /init\(from decoder/);
});

test('generate-ios-api: properties that exclude each other become one enum', () => {
  const doc = apiFixture();
  doc.components.schemas.Thing.properties.temp_c = { type: 'integer' };
  doc.components.schemas.Thing.properties.temp_special = { $ref: '#/components/schemas/Method' };
  doc.components.schemas.Thing.not = { required: ['temp_c', 'temp_special'] };
  assert.throws(() => generateFixture(doc), /`not` is supported only for the pairs in EXCLUSIVE_GROUPS/);
  const groups = [{ schema: 'Thing', property: 'temp', type: 'Temp', cases: { temp_c: 'celsius', temp_special: 'special' } }];
  const swift = generateFixture(doc, { ...apiOptions, groups });
  assert.match(swift, /var temp: API\.Temp\?$/m);
  assert.doesNotMatch(swift, /var tempC|var tempSpecial/);
  assert.match(swift, /enum Temp: Hashable, Sendable \{\n {8}\/\/\/ `temp_c`\n {8}case celsius\(Int\)\n {8}\/\/\/ `temp_special`\n {8}case special\(Vocabulary\.Method\)\n {4}\}/);
  assert.match(swift, /guard tempValues\.count <= 1 else \{/);
  assert.match(swift, /case \.celsius\(let member\):\n\s+try container\.encode\(member, forKey: \.tempC\)/);
  const wrongPair = structuredClone(doc);
  wrongPair.components.schemas.Thing.not = { required: ['temp_c', 'note_count'] };
  assert.throws(() => generateFixture(wrongPair, { ...apiOptions, groups }), /EXCLUSIVE_GROUPS expects/);
  assert.throws(() => generateFixture(apiFixture(), { ...apiOptions, groups }), /EXCLUSIVE_GROUPS expects/);
});

test('generate-ios-api: shapes it cannot represent fail instead of being dropped', () => {
  const cases = [
    [(d) => { d.components.schemas.Thing.properties.x = { oneOf: [{ type: 'integer' }] }; }, /keyword oneOf is not supported/],
    [(d) => { d.components.schemas.Thing.properties.x = { type: 'object', additionalProperties: false }; }, /inline object/],
    [(d) => { d.components.schemas.Thing.properties.x = { type: 'string', enum: ['a'] }; }, /inline enum/],
    [(d) => { delete d.components.schemas.Thing.additionalProperties; }, /additionalProperties: false/],
    [(d) => { d.components.schemas.Thing.properties.x = { type: 'string', format: 'date' }; }, /inline enum or format/],
    [(d) => { d.paths['/things'].post.responses[200] = d.paths['/things'].post.responses[201]; }, /exactly one 2xx/],
    [(d) => { d.paths['/things'].post.requestBody.content = { 'text/csv': { schema: { type: 'string' } } }; }, /request body must be application\/json/],
    [(d) => { d.components.schemas.Day = { type: 'string', format: 'date' }; d.components.schemas.Thing.properties.day = { $ref: '#/components/schemas/Day' }; }, /must be the component CalendarDate/],
    [(d) => { d.components.schemas.Thing.properties.undecodable_items = { type: 'integer' }; }, /clashes with a generated member/],
  ];
  for (const [mutate, expected] of cases) {
    const doc = apiFixture();
    mutate(doc);
    assert.throws(() => generateFixture(doc), expected);
  }
});

test('generate-ios-api: the output is deterministic', () => {
  assert.equal(generateFixture(), generateFixture());
  const version = latestPublishedVersion();
  const real = () => generateApiSwift({ doc: loadOpenApi(), vocabularyVersion: version, vocabularyFiles: loadVocabulary(version) });
  assert.equal(real(), real());
});

/** The real contract, generated once for the structural tests below. */
const realApi = () => {
  const version = latestPublishedVersion();
  const doc = loadOpenApi();
  return { doc, swift: generateApiSwift({ doc, vocabularyVersion: version, vocabularyFiles: loadVocabulary(version) }), api: describeApi(doc, loadVocabulary(version)) };
};

test('generate-ios-api: the committed API.swift matches contracts/openapi.yaml', () => {
  assert.equal(readFileSync(API_GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n'), realApi().swift);
});

test('generate-ios-api: every user-facing route is covered, the health route is not', () => {
  const { doc, api } = realApi();
  const all = Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId));
  assert.deepEqual(api.operations.map((o) => o.operationId), all.filter((id) => id !== 'getHealth'));
  assert.deepEqual(Object.keys(EXCLUDED_OPERATIONS), ['getHealth']);
  const structs = api.structs.map((s) => s.name).sort();
  assert.deepEqual(structs, [
    'Bean', 'BeanAttributes', 'BeanCreate', 'Brew', 'BrewInput', 'BrewPage', 'BrewParameters', 'Consent', 'Intensities',
    'LabelPhotoUpload', 'LabelPhotoUploadFields', 'LabelPhotoUploadForm', 'OpenFoodFactsProduct', 'Profile', 'Rating',
    'Recipe', 'RecipeInput', 'RecipePage', 'Scores', 'ShelfEntry', 'ShelfEntryInput', 'ShelfEntryPage',
  ]);
  const ops = Object.fromEntries(api.operations.map((o) => [o.operationId, o]));
  assert.equal(ops.getCatalogueImage.responseContentType, 'image/jpeg');
  assert.equal(ops.exportData.responseContentType, 'text/csv');
  assert.equal(ops.deleteAccount.successStatus, 204);
  assert.equal(ops.completeLabelPhoto.successStatus, 204);
});

test('generate-ios-api: the real contract maps vocabulary, dose, dates and water temperature as required', () => {
  const { swift } = realApi();
  // Vocabulary lists exist once, in Vocabulary.swift: every raw-valued case in API.swift is an
  // operationId, an HTTP method or a JSON property name (a CodingKey), never a list of ids.
  const { api } = realApi();
  const allowed = new Set([
    ...api.operations.map((o) => o.operationId),
    ...api.operations.map((o) => o.method.toUpperCase()),
    ...Object.values(api.structs).flatMap((s) => s.fields.flatMap((f) => (f.group ? f.members.map((m) => m.json) : [f.json]))),
  ]);
  const rawCases = [...swift.matchAll(/^\s*case \S+ = "([^"]*)"$/gm)].map((m) => m[1]);
  assert.ok(rawCases.length > 40);
  assert.deepEqual(rawCases.filter((raw) => !allowed.has(raw)), []);
  assert.doesNotMatch(swift, /enum (Method|MilkType|FlavourNote|Origin)\b/);
  assert.match(swift, /var flavourNotes: \[Vocabulary\.FlavourNote\]\?$/m);
  assert.match(swift, /var milk: Vocabulary\.MilkType\?$/m);
  assert.match(swift, /var locale: VocabularyLanguage$/m);
  assert.match(swift, /^extension VocabularyLanguage: Codable \{\}$/m);
  assert.match(swift, /subscript\(criterion: Vocabulary\.Criterion\) -> API\.Score \{/);
  // dose_dg (ADR 0004).
  assert.match(swift, /typealias DoseDg = Int$/m);
  assert.match(swift, /var doseGrams: Double\? \{/);
  // Dates.
  assert.match(swift, /var purchaseDate: API\.CalendarDate$/m);
  assert.match(swift, /var roastDate: API\.CalendarDate\?$/m);
  assert.match(swift, /var brewedAt: API\.Timestamp$/m);
  assert.match(swift, /var expiresAt: API\.Timestamp$/m);
  assert.match(swift, /struct CalendarDate: Codable, Hashable, Comparable, Sendable, CustomStringConvertible \{/);
  assert.match(swift, /formatter\.formatOptions = \[\.withInternetDateTime, \.withFractionalSeconds\]/);
  // Water temperature: one enum, never two stored properties.
  const params = swift.slice(swift.indexOf('struct BrewParameters'), swift.indexOf('enum WaterTemperature'));
  assert.match(params, /var waterTemperature: API\.WaterTemperature\?$/m);
  assert.doesNotMatch(params, /var waterTemp(C|Special)\b/);
  assert.match(params, /case waterTempC = "water_temp_c"/);
  assert.match(params, /case waterTempSpecial = "water_temp_special"/);
  assert.match(swift, /case celsius\(API\.WaterTempC\)\n.*\n\s+case special\(Vocabulary\.WaterTempSpecial\)/);
  // Pages decode item by item.
  for (const page of ['ShelfEntryPage', 'BrewPage', 'RecipePage']) {
    assert.match(swift, new RegExp(`struct ${page}: APIObject \\{[\\s\\S]*?DecodingAttempt<API\\.[A-Za-z]+>[\\s\\S]*?\\n {4}\\}`), page);
  }
});

test('generate-ios-api: the generated Swift is balanced and has no force unwraps or traps', () => {
  const { swift } = realApi();
  const { masked } = lexSwift(swift);
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    assert.equal(masked.split(open).length, masked.split(close).length, `${open}${close} unbalanced`);
  }
  assert.doesNotMatch(masked, /[A-Za-z0-9_)\]]!(?!=)/, 'force unwrap');
  assert.doesNotMatch(masked, /\btry!|\bas!|fatalError|preconditionFailure/);
  assert.doesNotMatch(masked, /\b(TextField|TextEditor|SecureField)\b/);
  assert.deepEqual(literalUiStrings(swift), []);
});

test('generate-ios-api: --check exits 1 on a stale or missing file and 0 on a fresh one (M2-T8)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const script = fileURLToPath(new URL('./generate-ios-api.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'cupmark-api-check-'));
  const check = (file) => spawnSync(process.execPath, [script, '--check', `--file=${file}`], { encoding: 'utf8' });
  try {
    const fresh = join(dir, 'fresh.swift');
    writeFileSync(fresh, realApi().swift);
    assert.equal(check(fresh).status, 0, check(fresh).stderr);

    const stale = join(dir, 'stale.swift');
    writeFileSync(stale, realApi().swift.replace('case .deleteAccount: return 204', 'case .deleteAccount: return 200'));
    const staleRun = check(stale);
    assert.equal(staleRun.status, 1);
    assert.match(staleRun.stderr, /out of date/);

    const missingRun = check(join(dir, 'missing.swift'));
    assert.equal(missingRun.status, 1);
    assert.match(missingRun.stderr, /is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate-ios-api: each route lists its documented error statuses, and Timestamp caches its formatters (M2-T8)', () => {
  const ops = describeOperations(apiFixture(), apiOptions.excluded);
  assert.deepEqual(ops.map((o) => [o.operationId, o.errorStatuses]), [
    ['listThings', []],
    ['createThing', [400]],
    ['deleteThing', []],
    ['getPicture', []],
  ]);
  const bad = apiFixture();
  bad.paths['/things/{id}'].delete.responses.default = { description: 'any' };
  assert.throws(() => describeOperations(bad, apiOptions.excluded), /response default is not a 2xx, 4xx or 5xx status/);

  const { swift } = realApi();
  assert.match(swift, /case \.lookupOpenFoodFacts: return \[400, 401, 404, 409, 429, 503\]/);
  assert.match(swift, /case \.deleteAccount: return \[401, 429\]/);
  const timestamp = swift.slice(swift.indexOf('struct Timestamp'), swift.indexOf('// MARK: - Support'));
  assert.equal(timestamp.match(/ISO8601DateFormatter\(\)/g)?.length, 2, 'one formatter per format');
  assert.match(timestamp, /private static let fractionalSeconds: ISO8601DateFormatter = \{/);
  assert.match(timestamp, /private static let wholeSeconds: ISO8601DateFormatter = \{/);
});

// Stage configuration (M2-T9, ADR 0023). The Swift checks run in XCTest on a Mac; these
// check on Linux that the xcconfigs, Info.plist and the project agree.
const readXcconfig = (name) => {
  const settings = {};
  for (const line of readFileSync(join(repoRoot, 'ios', 'Config', name), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const match = /^([A-Z_]+) = (.*)$/.exec(trimmed);
    assert.ok(match, `${name}: unexpected line ${trimmed}`);
    assert.ok(!match[2].includes('//'), `${name}: ${match[1]} has "//", which starts a comment in an xcconfig`);
    // `$()` expands to nothing; it keeps "//" in URLs from starting a comment.
    settings[match[1]] = match[2].replaceAll('$()', '');
  }
  return settings;
};

const STAGE_SETTINGS = {
  CupmarkStage: 'CUPMARK_STAGE',
  CupmarkHostedDomain: 'CUPMARK_HOSTED_DOMAIN',
  CupmarkAppClientID: 'CUPMARK_APP_CLIENT_ID',
  CupmarkAPIURL: 'CUPMARK_API_URL',
  CupmarkRedirectURL: 'CUPMARK_REDIRECT_URL',
  CupmarkSignOutURL: 'CUPMARK_SIGN_OUT_URL',
};

test('stage config: Dev and Prod xcconfigs set every value, in eu-central-1, with the registered URLs (M2-T9)', () => {
  for (const [file, stage] of [['Dev.xcconfig', 'dev'], ['Prod.xcconfig', 'prod']]) {
    const settings = readXcconfig(file);
    assert.deepEqual(Object.keys(settings).sort(), Object.values(STAGE_SETTINGS).sort(), file);
    assert.equal(settings.CUPMARK_STAGE, stage);
    assert.equal(settings.CUPMARK_HOSTED_DOMAIN, `https://cupmark-${stage}.auth.eu-central-1.amazoncognito.com`);
    assert.equal(settings.CUPMARK_REDIRECT_URL, 'cupmark://auth');
    assert.equal(settings.CUPMARK_SIGN_OUT_URL, 'cupmark://signout');
    assert.match(settings.CUPMARK_API_URL, /^https:\/\/[^/]+\.execute-api\.eu-central-1\.amazonaws\.com$/);
    for (const [name, value] of Object.entries(settings)) {
      assert.ok(!/(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d/.test(value.replaceAll('eu-central-1', '')), `${file}: ${name} names another region`);
    }
  }
  // Until M6 the prod ids are placeholders that StageConfig rejects:
  // uppercase and hyphens are not valid in an app client id or an API id.
  assert.match(readXcconfig('Prod.xcconfig').CUPMARK_APP_CLIENT_ID, /^PLACEHOLDER-/);
});

test('stage config: Dev holds the real ids of cupmark-dev-core that StageConfig accepts (M2-T10)', () => {
  const dev = readXcconfig('Dev.xcconfig');
  // StageConfig: an app client id is letters and digits; an API id is 10 lowercase letters and digits.
  assert.match(dev.CUPMARK_APP_CLIENT_ID, /^[A-Za-z0-9]{1,128}$/);
  assert.doesNotMatch(dev.CUPMARK_APP_CLIENT_ID, /PLACEHOLDER/);
  assert.match(dev.CUPMARK_API_URL, /^https:\/\/[a-z0-9]{10}\.execute-api\.eu-central-1\.amazonaws\.com$/);
});

test('stage config: the callback URLs match infra/src/identity.ts (M2-T9)', () => {
  const identity = readFileSync(join(repoRoot, 'infra', 'src', 'identity.ts'), 'utf8');
  assert.match(identity, /APP_CALLBACK_URL = 'cupmark:\/\/auth'/);
  assert.match(identity, /APP_SIGN_OUT_URL = 'cupmark:\/\/signout'/);
  const swift = readFileSync(join(repoRoot, 'ios', 'Cupmark', 'Configuration', 'StageConfig.swift'), 'utf8');
  assert.match(swift, /static let redirectURLString = "cupmark:\/\/auth"/);
  assert.match(swift, /static let signOutURLString = "cupmark:\/\/signout"/);
  assert.match(swift, /static let region = "eu-central-1"/);
  for (const key of Object.keys(STAGE_SETTINGS)) {
    assert.match(swift, new RegExp(`= "${key}"`), `StageConfig.InfoKey lacks ${key}`);
  }
});

test('stage config: Info.plist maps every key to its setting, and both app configurations use Dev (M2-T9, ADR 0023)', () => {
  const plist = readFileSync(join(repoRoot, 'ios', 'Config', 'Info.plist'), 'utf8');
  for (const [key, setting] of Object.entries(STAGE_SETTINGS)) {
    assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>\\$\\(${setting}\\)</string>`), key);
  }
  const project = readFileSync(PROJECT_FILE, 'utf8');
  assert.match(project, /\/\* Dev\.xcconfig \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.xcconfig; name = Dev\.xcconfig; path = Config\/Dev\.xcconfig; sourceTree = SOURCE_ROOT; \};/);
  for (const name of ['Debug', 'Release']) {
    const start = project.search(new RegExp(`C0FFEE000000000000000044 /\\* ${name} \\*/ = \\{|C0FFEE000000000000000045 /\\* ${name} \\*/ = \\{`));
    assert.ok(start >= 0, `app configuration ${name}`);
    const block = project.slice(start, project.indexOf(`name = ${name};`, start));
    assert.match(block, /baseConfigurationReference = C0FFEE000000000000000051 \/\* Dev\.xcconfig \*\/;/, name);
    assert.match(block, /INFOPLIST_FILE = Config\/Info\.plist;/, name);
    assert.match(block, /GENERATE_INFOPLIST_FILE = YES;/, name);
  }
  // Info.plist sits outside the synchronized Cupmark/ folder, so it is not also copied as a resource.
  assert.ok(!existsSync(join(repoRoot, 'ios', 'Cupmark', 'Info.plist')));
});

// ---- InfoPlist.xcstrings (M2-T13) ----

const pbxWithCamera = (...values) =>
  values.map((v) => `\t\t\t\tINFOPLIST_KEY_NSCameraUsageDescription = "${v}";\n`).join('');

test('usageDescriptionSettings reads quoted and bare usage descriptions from the project', () => {
  const settings = usageDescriptionSettings(`${pbxWithCamera('Reads "codes".'.replace(/"/g, '\\"'))}\t\tINFOPLIST_KEY_NSPhotoLibraryUsageDescription = Photos;\n\t\tINFOPLIST_KEY_CFBundleDisplayName = Cupmark;\n`);
  assert.deepEqual([...settings.keys()], ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']);
  assert.deepEqual([...settings.get('NSCameraUsageDescription')], ['Reads "codes".']);
  assert.deepEqual([...settings.get('NSPhotoLibraryUsageDescription')], ['Photos']);
});

test('checkInfoPlistCatalog requires every usage description localised, with the project value in English', () => {
  const catalog = (strings) => ({ sourceLanguage: 'en', strings });
  const camera = entry({ en: unit('Reads codes.'), de: unit('Liest Codes.') });
  assert.deepEqual(checkInfoPlistCatalog(catalog({ NSCameraUsageDescription: camera }), pbxWithCamera('Reads codes.', 'Reads codes.'), ['en', 'de']), []);
  // Missing from the catalog.
  assert.equal(checkInfoPlistCatalog(catalog({}), pbxWithCamera('Reads codes.'), ['en', 'de']).length, 1);
  // English differs from the build setting.
  assert.match(checkInfoPlistCatalog(catalog({ NSCameraUsageDescription: camera }), pbxWithCamera('Other.'), ['en', 'de']).join('\n'), /differs/);
  // Configurations disagree.
  assert.match(checkInfoPlistCatalog(catalog({ NSCameraUsageDescription: camera }), pbxWithCamera('Reads codes.', 'Other.'), ['en', 'de']).join('\n'), /disagree/);
  // A key the project does not set.
  assert.match(checkInfoPlistCatalog(catalog({ NSCameraUsageDescription: camera, NSMicrophoneUsageDescription: camera }), pbxWithCamera('Reads codes.'), ['en', 'de']).join('\n'), /NSMicrophoneUsageDescription/);
  // German missing: the catalog rules apply too.
  const noGerman = entry({ en: unit('Reads codes.') });
  assert.equal(checkInfoPlistCatalog(catalog({ NSCameraUsageDescription: noGerman }), pbxWithCamera('Reads codes.'), ['en', 'de']).length, 1);
});

test('the committed InfoPlist.xcstrings localises the camera permission in en and de', () => {
  const catalog = JSON.parse(readFileSync(new URL('../ios/Cupmark/InfoPlist.xcstrings', import.meta.url), 'utf8'));
  const pbxproj = readFileSync(new URL('../ios/Cupmark.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  assert.deepEqual(checkInfoPlistCatalog(catalog, pbxproj), []);
  assert.ok(usageDescriptionSettings(pbxproj).has('NSCameraUsageDescription'));
  assert.ok(catalog.strings.NSCameraUsageDescription);
});

// ---- Localisation pass (M2-T32) ----

test('checkInfoPlistCatalog fails a usage description missing a language or not extractionState manual', () => {
  const catalog = (e) => ({ sourceLanguage: 'en', strings: { NSCameraUsageDescription: e } });
  const pbx = pbxWithCamera('Reads codes.');
  const complete = { extractionState: 'manual', localizations: { en: unit('Reads codes.'), de: unit('Liest Codes.') } };
  assert.deepEqual(checkInfoPlistCatalog(catalog(complete), pbx, ['en', 'de']), []);
  // Each language, in turn, missing.
  for (const lang of ['en', 'de']) {
    const { [lang]: _gone, ...rest } = complete.localizations;
    const problems = checkInfoPlistCatalog(catalog({ ...complete, localizations: rest }), pbx, ['en', 'de']);
    assert.ok(problems.some((p) => p.includes(`no ${lang} value`)), `${lang}: ${problems.join('; ')}`);
  }
  // An untranslated German value and a catalog Xcode may mark stale.
  assert.ok(checkInfoPlistCatalog(catalog({ ...complete, localizations: { en: unit('Reads codes.'), de: unit('Liest Codes.', 'new') } }), pbx, ['en', 'de']).length > 0);
  for (const state of [undefined, 'stale', 'extracted_with_value']) {
    const problems = checkInfoPlistCatalog(catalog({ ...complete, extractionState: state }), pbx, ['en', 'de']);
    assert.ok(problems.some((p) => /extractionState/.test(p)), `${state}: ${problems.join('; ')}`);
  }
});

test('the committed InfoPlist.xcstrings is run through the same check by main (and so by the ios job)', () => {
  const source = readFileSync(new URL('./check-ios-strings.mjs', import.meta.url), 'utf8');
  assert.match(source, /checkInfoPlistCatalog\(infoPlistCatalog/);
});

test('every L10n key resolves to a non-empty translation in en and de, and L10n and the catalogue list the same keys', () => {
  const catalog = JSON.parse(readFileSync(new URL('../ios/Cupmark/Localizable.xcstrings', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../ios/Cupmark/L10n.swift', import.meta.url), 'utf8');
  const keys = keysInL10n(source);
  assert.ok(keys.length > 300, `only ${keys.length} keys found; did the L10n pattern stop matching?`);
  // As many keys as members: a member the pattern cannot read would escape every check below.
  const members = source.match(/^\s*static (?:var|func) /gm) ?? [];
  assert.equal(keys.length, members.length, 'a member of L10n.swift is not a key the checker reads');
  for (const key of keys) {
    for (const lang of ['en', 'de']) {
      const value = catalog.strings[key]?.localizations?.[lang]?.stringUnit?.value;
      assert.equal(typeof value, 'string', `${key} has no ${lang} value`);
      assert.notEqual(value.trim(), '', `${key} is empty in ${lang}`);
    }
  }
  assert.deepEqual(checkKeys(keys, Object.keys(catalog.strings)), []);
  assert.deepEqual([...new Set(keys)].sort(), Object.keys(catalog.strings).sort());
});

test('keysInL10n reads a key looked up in a given bundle (the ratio)', () => {
  const source = 'enum L10n {\n    static func r(_ number: String, bundle: Bundle = .main) -> String { String(localized: "r.value \\(number)", bundle: bundle) }\n}';
  assert.deepEqual(keysInL10n(source), ['r.value %@']);
});

test('checkCatalog fails a value that drops or adds a placeholder of its key', () => {
  const catalog = (de) => ({ sourceLanguage: 'en', strings: { 'a.b %@': entry({ en: unit('Grind %@'), de: unit(de) }) } });
  assert.deepEqual(checkCatalog(catalog('Mahlgrad %@'), ['en', 'de']), []);
  assert.deepEqual(checkCatalog(catalog('Mahlgrad %1$@'), ['en', 'de']), []);
  assert.match(checkCatalog(catalog('Mahlgrad'), ['en', 'de']).join('\n'), /de value has 0 placeholders, the key has 1/);
  assert.equal(checkCatalog(catalog('%@ und %@'), ['en', 'de']).length, 1);
});

test('the ratio prefix is in the catalogue, not in BrewFormat', () => {
  const catalog = JSON.parse(readFileSync(new URL('../ios/Cupmark/Localizable.xcstrings', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de']) assert.equal(catalog.strings['brew.ratio.value %@'].localizations[lang].stringUnit.value, '1:%@');
  const draft = readFileSync(new URL('../ios/Cupmark/Brew/BrewDraft.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(lexSwift(draft).masked, /"1:"/);
  assert.match(draft, /L10n\.brewRatioValue\(/);
});

test('one function decides the language: the profile locale and the vocabulary labels share it', () => {
  const rules = readFileSync(new URL('../ios/Cupmark/Onboarding/OnboardingRules.swift', import.meta.url), 'utf8');
  const item = readFileSync(new URL('../ios/Cupmark/Vocabulary/VocabularyItem.swift', import.meta.url), 'utf8');
  const load = readFileSync(new URL('../ios/Cupmark/VocabularyLoadState.swift', import.meta.url), 'utf8');
  assert.match(rules, /VocabularyLanguage\.resolving\(preferredLanguages: preferredLanguages\)/);
  assert.doesNotMatch(lexSwift(rules).masked, /Locale\.Language|languageCode/, 'the rule is not copied into OnboardingRules');
  assert.match(item, /static func resolving\(preferredLanguages/);
  assert.match(load, /VocabularyLanguage\.current/);
  // The Foundation date and number styles are the only ones: no pattern strings, no String(format:) in views.
  for (const [dir] of [['Brew'], ['Rating'], ['Shelf'], ['Statistics'], ['Onboarding'], ['Settings'], ['Export'], ['AccountDeletion']]) {
    for (const name of m2t32Fs.readdirSync(new URL(`../ios/Cupmark/${dir}/`, import.meta.url))) {
      if (!name.endsWith('.swift')) continue;
      const masked = lexSwift(readFileSync(new URL(`../ios/Cupmark/${dir}/${name}`, import.meta.url), 'utf8')).masked;
      assert.doesNotMatch(masked, /\bDateFormatter\s*\(|\bdateFormat\s*=/, `${dir}/${name} writes a date pattern`);
      if (name !== 'ExportFileStore.swift') assert.doesNotMatch(masked, /String\(format:/, `${dir}/${name} formats by hand`);
    }
  }
});

import * as m2t32Fs from 'node:fs';

// ---- Lookup and confirm flow (M2-T14, ADR 0005, ADR 0011) ----

import * as m2t14Fs from 'node:fs';

/** Every file under `dir`, recursively, as paths relative to the repository root. */
const m2t14Files = (dir) => {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  return m2t14Fs.readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath ?? entry.path, entry.name)));
};

test('the app never names an Open Food Facts host: images and text come through our API (M2-T14, ADR 0011)', () => {
  const files = ['ios/Cupmark', 'ios/CupmarkTests', 'ios/Config', 'ios/Cupmark.xcodeproj'].flatMap(m2t14Files);
  assert.ok(files.some((file) => file.endsWith('LookupModel.swift')), 'the lookup sources are scanned');
  const offenders = files.filter((file) => /openfoodfacts\.org/i.test(readFileSync(join(repoRoot, file), 'latin1')));
  assert.deepEqual(offenders, []);
});

test('Open Food Facts name and brand are shown only with Text(verbatim:) (M2-T14, ADR 0005)', () => {
  const pattern = /\bText\(\s*(?!verbatim:)[^)\n]*\b(name|brand)\b/;
  assert.match('Text(product.name)', pattern);
  assert.match('Text(brand)', pattern);
  assert.doesNotMatch('Text(verbatim: name)', pattern);
  assert.doesNotMatch('Text(L10n.openFoodFactsName)', pattern);
  const swift = m2t14Files('ios/Cupmark').filter((file) => file.endsWith('.swift'));
  const offenders = swift.filter((file) => pattern.test(lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked));
  assert.deepEqual(offenders, []);
  const views = readFileSync(join(repoRoot, 'ios/Cupmark/Lookup/OpenFoodFactsViews.swift'), 'utf8');
  assert.match(views, /Text\(verbatim: name\)/);
  assert.match(views, /Text\(verbatim: brand\)/);
});

// ---- Pick-list bean entry (M2-T22, ADR 0006, ADR 0011) ----

test('the pick-list entry has no roaster, no typed text and no hand-written vocabulary (M2-T22)', () => {
  const files = m2t14Files('ios/Cupmark/BeanEntry').filter((file) => file.endsWith('.swift'));
  assert.ok(files.some((file) => file.endsWith('BeanEntryModel.swift')), 'the bean entry sources are scanned');
  for (const file of files) {
    // Comments and string contents blanked: only code counts.
    const code = lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked;
    assert.doesNotMatch(code, /roaster/i, `${file}: no roaster pick (ADR 0006)`);
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b/, `${file}: no typed text (invariant 1)`);
    // Values are Vocabulary enums: no id is written as a string.
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
  }
  const sections = readFileSync(join(repoRoot, 'ios/Cupmark/BeanEntry/PickListSections.swift'), 'utf8');
  assert.match(sections, /\$0\.country == nil/, 'origins are grouped through Vocabulary.Origin.country');
  assert.match(sections, /\$0\.country == country/);
});

test('the scan flow pushes the pick-list entry with the scanned barcode, and the scanner stops its camera (M2-T22)', () => {
  const flow = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Lookup/LookupScreen.swift'), 'utf8')).masked;
  assert.match(flow, /openEntry\(barcode: lookup\.barcode\)/);
  assert.match(flow, /openEntry\(barcode: nil\)/);
  assert.match(flow, /BeanEntryScreen\(/);
  const screen = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Scanner/ScannerScreen.swift'), 'utf8')).masked;
  assert.match(screen, /\.onDisappear\s*\{[^}]*source\?\.stop\(\)/);
  const model = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Scanner/ScannerViewModel.swift'), 'utf8')).masked;
  assert.match(model, /Task\.isCancelled[^}]*source\.stop\(\)/);
});

// ---- Shelf (M2-T18, ADR 0005, ADR 0025, D14) ----

/**
 * Places in a Swift file where Open Food Facts text (`name`, `brand`, `openFoodFactsName`,
 * `openFoodFactsBrand`) reaches a view other than through `Text(verbatim:)`: any argument of
 * `Text(` that is not `verbatim:`, and any argument of `LabeledContent(`, `Label(`,
 * `Button(`, `navigationTitle(`, `accessibilityLabel(` or `accessibilityValue(`. The
 * arguments run to the matching parenthesis, across lines; comments and string contents are
 * blanked first, and `L10n.` keys (such as `L10n.openFoodFactsName`) are not text. Trailing
 * closures (`LabeledContent { ... }`) are not arguments; the `Text` inside them is checked
 * on its own.
 */
const m2t18OffCall =
  /\b(Text|LabeledContent|Label|Button|navigationTitle|accessibilityLabel|accessibilityValue|NavigationLink|Section|Toggle|Picker|alert|confirmationDialog|ContentUnavailableView|LocalizedStringKey)\s*\(/g;
const m2t18OffField = /\b(name|brand|openFoodFactsName|openFoodFactsBrand)\b/;
// In interpolations a bare `name` is everywhere (file names, path parameters), so there only
// a member `.name`, any `brand` and the stored columns count.
const m2t18OffInterpolated = /\.\s*name\b|\b(brand|openFoodFactsName|openFoodFactsBrand)\b/;
function m2t18OpenFoodFactsTextOutsideVerbatim(source) {
  const { masked, strings } = lexSwift(source);
  const found = [];
  // Any string interpolation of the fields, wherever the string goes (review of M2-T18):
  // `"\(name)"` turns untrusted text into a literal's content, a key or a log line.
  for (const [start, end] of strings) {
    const literal = source.slice(start, end);
    const hashes = /^#*/.exec(literal)[0];
    const opener = `\\${hashes}(`;
    let at = literal.indexOf(opener);
    while (at !== -1) {
      let depth = 1;
      let k = at + opener.length;
      for (; k < literal.length && depth > 0; k += 1) {
        if (literal[k] === '(') depth += 1;
        else if (literal[k] === ')') depth -= 1;
      }
      const inner = literal.slice(at + opener.length, k - 1).replace(/\bL10n\s*\.\s*\w+/g, '');
      if (m2t18OffInterpolated.test(inner)) {
        found.push({ line: source.slice(0, start).split('\n').length, call: 'interpolation' });
      }
      at = literal.indexOf(opener, k);
    }
  }
  for (const match of masked.matchAll(m2t18OffCall)) {
    const open = match.index + match[0].length;
    let depth = 1;
    let close = open;
    for (; close < masked.length; close += 1) {
      const ch = masked[close];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = masked.slice(open, close).replace(/\bL10n\s*\.\s*\w+/g, '');
    if (match[1] === 'Text' && /^\s*verbatim\s*:/.test(args)) continue;
    if (m2t18OffField.test(args)) {
      found.push({ line: masked.slice(0, match.index).split('\n').length, call: match[1] });
    }
  }
  return found;
}

test('Open Food Facts text check: only Text(verbatim:) passes, also across lines and in LabeledContent and Label (M2-T18)', () => {
  const flagged = (source) => m2t18OpenFoodFactsTextOutsideVerbatim(source).map(({ call }) => call);
  assert.deepEqual(flagged('Text(verbatim: name)'), []);
  assert.deepEqual(flagged('Text(\n    verbatim: summary.brand\n)'), []);
  assert.deepEqual(flagged('Text(L10n.openFoodFactsName)'), []);
  assert.deepEqual(flagged('LabeledContent {\n    Text(verbatim: name)\n} label: {\n    Text(L10n.openFoodFactsName)\n}'), []);
  assert.deepEqual(flagged('Image(systemName: "x")'), []);
  assert.deepEqual(flagged('Text(name)'), ['Text']);
  assert.deepEqual(flagged('Text(product.brand)'), ['Text']);
  assert.deepEqual(flagged('Text(\n    bean.openFoodFactsName ?? fallback\n)'), ['Text']);
  assert.deepEqual(flagged('Text(\n    LocalizedStringKey(name)\n)'), ['Text', 'LocalizedStringKey']);
  assert.deepEqual(flagged('LabeledContent("Name", value: name)'), ['LabeledContent']);
  assert.deepEqual(flagged('LabeledContent(L10n.openFoodFactsName, value: product.brand ?? other)'), ['LabeledContent']);
  assert.deepEqual(flagged('Label(name, systemImage: "cup.and.saucer")'), ['Label']);
  assert.deepEqual(flagged('Label(\n    summary.name ?? other,\n    systemImage: "cup.and.saucer"\n)'), ['Label']);
  assert.deepEqual(flagged('.navigationTitle(bean.openFoodFactsBrand ?? other)'), ['navigationTitle']);
  assert.deepEqual(flagged('.accessibilityLabel(Text(name))'), ['accessibilityLabel', 'Text']);
  // A comment or a string that mentions the fields is not code.
  assert.deepEqual(flagged('Text(L10n.shelfBeanUnnamed) // not Text(name)'), []);
  assert.deepEqual(flagged('let note = "name and brand"'), []);
  // String interpolations, anywhere, also in raw strings and nested parentheses.
  assert.deepEqual(flagged('let title = "\\(product.name)"'), ['interpolation']);
  assert.deepEqual(flagged('let title = "\\(brand) roast"'), ['interpolation']);
  // A bare `name` in an interpolation is a file or parameter name, not Open Food Facts text.
  assert.deepEqual(flagged('let file = "\\(name).json"'), []);
  assert.deepEqual(flagged('log("bean \\(bean.openFoodFactsBrand ?? (other))")'), ['interpolation']);
  assert.deepEqual(flagged('let raw = #"\\#(summary.name)"#'), ['interpolation']);
  assert.deepEqual(flagged('let id = "\\(row.valueID) \\(count)"'), []);
  assert.deepEqual(flagged('Text(verbatim: "\\(brand)")').sort(), ['interpolation']);
  // The other calls that put text on screen.
  assert.deepEqual(flagged('NavigationLink(name, value: route)'), ['NavigationLink']);
  assert.deepEqual(flagged('Section(product.brand ?? other) {\n    Text(verbatim: x)\n}'), ['Section']);
  assert.deepEqual(flagged('Toggle(name, isOn: $on)'), ['Toggle']);
  assert.deepEqual(flagged('Picker(\n    summary.name ?? other,\n    selection: $pick\n) {}'), ['Picker']);
  assert.deepEqual(flagged('.alert(name, isPresented: $shown) {}'), ['alert']);
  assert.deepEqual(flagged('.confirmationDialog(bean.openFoodFactsName ?? other, isPresented: $shown) {}'), ['confirmationDialog']);
  assert.deepEqual(flagged('ContentUnavailableView(brand, systemImage: "cup.and.saucer")'), ['ContentUnavailableView']);
  assert.deepEqual(flagged('Text(LocalizedStringKey(name))'), ['Text', 'LocalizedStringKey']);
  // Not text: these keep passing.
  assert.deepEqual(flagged('Section {\n    Text(verbatim: name)\n} header: {\n    Text(L10n.openFoodFactsHeader)\n}'), []);
  assert.deepEqual(flagged('OpenFoodFactsSection(product: product, loadImage: load)'), []);
  assert.deepEqual(flagged('Toggle(isOn: $on) {\n    Text(L10n.shelfEntryRoastDateKnown)\n}'), []);
  assert.deepEqual(flagged('.confirmationDialog(L10n.syncIssuesDiscardConfirmTitle, isPresented: $shown) {}'), []);
});

test('the committed iOS sources show Open Food Facts name and brand only with Text(verbatim:) (M2-T18)', () => {
  const swift = m2t14Files('ios/Cupmark').filter((file) => file.endsWith('.swift'));
  assert.ok(swift.some((file) => file.endsWith('ShelfViews.swift')), 'the shelf sources are scanned');
  const offenders = swift.flatMap((file) =>
    m2t18OpenFoodFactsTextOutsideVerbatim(readFileSync(join(repoRoot, file), 'utf8')).map(({ line, call }) => `${file}:${line} ${call}`),
  );
  assert.deepEqual(offenders, []);
  const views = readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfViews.swift'), 'utf8');
  assert.match(views, /Text\(verbatim: name\)/);
  assert.match(views, /Text\(verbatim: brand\)/);
});

test('the shelf has no typed text, no hand-written vocabulary and writes only through AccountStore (M2-T18)', () => {
  const files = m2t14Files('ios/Cupmark/Shelf').filter((file) => file.endsWith('.swift'));
  assert.ok(files.some((file) => file.endsWith('ShelfEntryEditorModel.swift')), 'the shelf sources are scanned');
  for (const file of files) {
    const code = lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked;
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
    // Screens edit drafts; the store's methods insert, save and queue (ADR 0025).
    assert.doesNotMatch(code, /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: no direct insert, save or delete on the context`);
  }
  const editor = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfEntryEditorModel.swift'), 'utf8')).masked;
  assert.match(editor, /store\.addShelfEntry\(/);
  assert.match(editor, /store\.markUpdated\(entry\)/);
  assert.match(editor, /store\.markDeleted\(entry\)/);
  assert.match(editor, /liveBrewCount/);
  const screen = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfEntryEditorScreen.swift'), 'utf8')).masked;
  assert.match(screen, /\.disabled\(!model\.canChangeBean\)/, 'the bean change is disabled while brews reference the entry (D14)');
  assert.match(screen, /\.disabled\(!model\.canDelete\)/, 'the removal is disabled while brews reference the entry (ADR 0012)');
  assert.match(screen, /L10n\.shelfEntryLockedReason/, 'with a localised reason');
});

test('the shelf is the signed-in root and the scan flow can add to it (M2-T18)', () => {
  const root = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/RootView.swift'), 'utf8')).masked;
  assert.match(root, /AuthGate\s*\{\s*account in\s*signedInContent\(account\)/);
  assert.match(root, /ShelfRoot\(account: account/);
  const shelf = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfScreen.swift'), 'utf8')).masked;
  assert.match(shelf, /ScanFlowView\([^)]*shelf: ShelfAddContext\(/s);
  assert.match(shelf, /AccountStore\.didSaveNotification/);
  const lookup = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Lookup/LookupScreen.swift'), 'utf8')).masked;
  assert.match(lookup, /AddToShelfBar\(bean: bean/);
  assert.match(lookup, /case \.signInRequired:\s*SignInAgainView\(\)/);
  const entry = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/BeanEntry/BeanEntryScreen.swift'), 'utf8')).masked;
  assert.match(entry, /AddToShelfBar\(bean: bean/);
});

// ---- Brew form (M2-T19, docs/04 F2, ADR 0025) ----

test('the brew form has no typed text, takes its ranges from the vocabulary and writes only through AccountStore (M2-T19)', () => {
  const files = m2t14Files('ios/Cupmark/Brew').filter((file) => file.endsWith('.swift'));
  assert.ok(files.some((file) => file.endsWith('BrewFormScreen.swift')), 'the brew sources are scanned');
  for (const file of files) {
    const code = lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked;
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
    assert.doesNotMatch(code, /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: no direct insert, save or delete on the context`);
  }
  const draft = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewDraft.swift'), 'utf8')).masked;
  for (const range of ['doseG', 'waterG', 'waterTempC', 'grindNormalised']) {
    assert.match(draft, new RegExp(`Vocabulary\\.Ranges\\.${range}\\b`), `the ${range} stepper reads Vocabulary.Ranges.${range}`);
  }
  const model = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewFormModel.swift'), 'utf8')).masked;
  assert.match(model, /store\.addBrew\(brew, shelfEntry: entry, then: stageMore\)/);
  assert.match(model, /API\.Timestamp\(now\(\)\)/, 'brewed_at is recorded on the device');

  // No range is written in the view: no stepper bounds or steps, and no number of any brew range.
  const screen = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewFormScreen.swift'), 'utf8')).masked;
  assert.doesNotMatch(screen, /Stepper\s*\([^)]*\b(in|step|value)\s*:/s, 'steppers take no bounds or steps in the view');
  assert.doesNotMatch(screen, /Vocabulary\.Ranges/, 'the view reads ranges only through BrewNumberField');
  const generated = readFileSync(join(repoRoot, 'ios/Cupmark/Generated/Vocabulary.swift'), 'utf8');
  const version = /static let version = (\d+)/.exec(generated)[1];
  const brew = JSON.parse(readFileSync(join(repoRoot, `contracts/vocabulary/v${version}/brew.json`), 'utf8'));
  const rangeNumbers = new Set(
    Object.values(brew.ranges).flatMap(({ minimum, maximum, multipleOf }) => [minimum, maximum, multipleOf]),
  );
  const literals = [...screen.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((match) => Number(match[0]));
  assert.deepEqual(literals.filter((value) => rangeNumbers.has(value)), [], 'no range bound or step in the view');

  // Method rules and the grinder (M2-T26): the generated rules and scales, an A to Z list, no search.
  assert.match(draft, /method\.allows\(field\)/, 'the draft reads the generated method rules');
  assert.match(draft, /grinder\?\.scale/, 'the grind setting range is the grinder\'s generated scale');
  assert.match(screen, /IndexedPickListRow\(\s*title: L10n\.brewGrinder/, 'the grinder is an A to Z pick list');
  assert.match(screen, /model\.shows\(\.grinder\)/, 'the grinder is shown only where the method allows it');
  assert.doesNotMatch(screen, /\.preGround\b|"pre_ground"|\.coldBrew\b|\.fullyAutomatic\b/, 'no method or grinder is named in the view');

  // The brew starts from a shelf entry, in the sheet that then offers its rating (M2-T20).
  const shelf = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfScreen.swift'), 'utf8')).masked;
  assert.match(shelf, /BrewSheet\(store: store, route: route/);
  const editor = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfEntryEditorScreen.swift'), 'utf8')).masked;
  assert.match(editor, /BrewSheet\(store: model\.store, route: route/);
  const sheet = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewSheet.swift'), 'utf8')).masked;
  // The sheet's flow builds the form for the route's shelf entry and start (M2-T27).
  assert.match(sheet, /BrewFlowModel\(route: route, store: store\)/);
  assert.match(sheet, /BrewFormScreen\(\s*model: flow\.form/);
  const flow = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewFlowModel.swift'), 'utf8')).masked;
  assert.match(flow, /shelfEntry: route\.shelfEntryLocalID,[^)]*start: route\.start/s);
});

// ---- Brew timer (M2-T21, docs/04 Input model "Timer") ----

test('the brew timer measures from a start instant, takes brew_time_s from the vocabulary and writes no range in the view (M2-T21)', () => {
  const read = (file) => lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked;
  const timer = read('ios/Cupmark/Brew/BrewTimer.swift');
  assert.match(timer, /Vocabulary\.Ranges\.brewTimeS\b/, 'the clamp reads Vocabulary.Ranges.brewTimeS');
  assert.match(timer, /ContinuousClock/, 'a monotonic clock that keeps counting while the device sleeps');
  assert.match(timer, /startedAt\.duration\(to: instant\)/, 'the elapsed time is computed from the start instant');
  assert.doesNotMatch(timer, /\bTimer\.(publish|scheduledTimer)\b|\+= *1\b/, 'no counted-up ticks');
  const row = read('ios/Cupmark/Brew/BrewTimerRow.swift');
  assert.doesNotMatch(row, /Vocabulary\.Ranges/, 'the view reads no range');
  assert.match(row, /\.font\(\.largeTitle/, 'the readout uses a text style, so it follows Dynamic Type');
  assert.match(row, /accessibilityValue\(/, 'VoiceOver reads the elapsed time');
  const model = read('ios/Cupmark/Brew/BrewFormModel.swift');
  assert.match(model, /timer\.stop\(locale: locale\)/);
  const screen = read('ios/Cupmark/Brew/BrewFormScreen.swift');
  assert.match(screen, /BrewTimerRow\(/, 'the brew form shows the timer');
});

// ---- Rating (M2-T20, docs/04 F3, ADR 0025) ----

test('the rating has no typed text, takes its lists, scale and limit from the vocabulary and writes only through AccountStore (M2-T20)', () => {
  const files = m2t14Files('ios/Cupmark/Rating').filter((file) => file.endsWith('.swift'));
  assert.ok(files.some((file) => file.endsWith('RatingScreen.swift')), 'the rating sources are scanned');
  const read = (file) => lexSwift(readFileSync(join(repoRoot, file), 'utf8')).masked;
  for (const file of files) {
    const code = read(file);
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
    assert.doesNotMatch(code, /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: no direct insert, save or delete on the context`);
  }
  // The scale and the limit are read in one place, the draft; the views go through it.
  const draft = read('ios/Cupmark/Rating/RatingDraft.swift');
  assert.match(draft, /static var scale: VocabularyRange \{ Vocabulary\.Ranges\.scale \}/);
  assert.match(draft, /static var maxFlavourNotes: Int \{ Vocabulary\.Constants\.maxPicks \}/);
  for (const file of files.filter((name) => !name.endsWith('RatingDraft.swift'))) {
    assert.doesNotMatch(read(file), /Vocabulary\.(Ranges|Constants)/, `${file}: reads the scale and the limit through RatingDraft`);
  }
  // Every list is the generated one, in vocabulary order.
  const screen = read('ios/Cupmark/Rating/RatingScreen.swift');
  assert.match(screen, /ForEach\(Vocabulary\.Criterion\.allCases\)/);
  assert.match(screen, /ForEach\(Vocabulary\.IntensityDimension\.allCases\)/);
  assert.match(screen, /ForEach\(Vocabulary\.IntensityLevel\.allCases\)/);
  assert.match(screen, /Slider\(\s*value: \$value,\s*in: bounds,\s*step: RatingDraft\.scale\.multipleOf/s);
  assert.match(screen, /vocabulary\.question\(namespace: Vocabulary\.Criterion\.namespace/, 'each criterion shows its question from contracts/i18n');
  const lists = read('ios/Cupmark/Rating/FlavourNoteLists.swift');
  assert.match(lists, /ForEach\(Vocabulary\.FlavourCategory\.allCases\)/);
  assert.match(lists, /ForEach\(category\.flavourNotes\)/);
  assert.match(lists, /\.disabled\(!model\.draft\.canToggle\(note\)\)/, 'further picks are disabled at the limit');
  // The write goes through AccountStore and queues the brew's update.
  const model = read('ios/Cupmark/Rating/RatingFormModel.swift');
  assert.match(model, /store\.rateBrew\(brew, rating: rating\)/);
  const store = read('ios/Cupmark/Store/AccountStore+Rating.swift');
  assert.match(store, /try markUpdated\(brew\)/);
  // Rated right after the brew, or later from the shelf entry's brew list.
  const sheet = read('ios/Cupmark/Brew/BrewSheet.swift');
  assert.match(sheet, /RatingScreen\(\s*store: store,\s*brew: savedBrewID,\s*mode: \.afterBrew,\s*repeatedFrom: flow\.form\.copiedBrewID/);
  const list = read('ios/Cupmark/Brew/BrewListScreen.swift');
  assert.match(list, /NavigationLink\(value: BrewRatingRoute\(brewLocalID: row\.id\)\)/, 'the rating is made only when it opens');
  assert.match(list, /RatingScreen\(store: model\.store, brew: route\.brewLocalID, mode: \.later/);
  const editor = read('ios/Cupmark/Shelf/ShelfEntryEditorScreen.swift');
  assert.match(editor, /BrewListScreen\(store: model\.store, shelfEntry: route\.shelfEntryLocalID/);
});

test('label photo upload: the Swift patterns equal the contract, and the S3 POST never goes through APIClient (M2-T24)', () => {
  const doc = loadOpenApi();
  const schemas = doc.components.schemas;
  const source = readFileSync(join(repoRoot, 'ios/Cupmark/LabelPhoto/PresignedLabelPhotoPost.swift'), 'utf8');
  const swiftPatterns = Object.fromEntries(
    [...source.matchAll(/static let (\w+) = #"(.*)"#/g)].map((match) => [match[1], match[2]]),
  );
  const expected = { url: schemas.LabelPhotoUploadForm.properties.url.pattern };
  for (const [name, property] of Object.entries(schemas.LabelPhotoUploadFields.properties)) {
    expected[lowerCamel(name)] = property.pattern;
  }
  assert.deepEqual(swiftPatterns, expected);
  for (const pattern of Object.values(expected)) assert.ok(pattern.startsWith('^') && pattern.endsWith('$'));

  // Every contract field has an S3 field name in the app, the security token is the only optional one.
  assert.deepEqual(
    [...schemas.LabelPhotoUploadFields.required].sort(),
    Object.keys(schemas.LabelPhotoUploadFields.properties).filter((name) => name !== 'x_amz_security_token').sort(),
  );
  for (const name of ['key', 'bucket', 'Content-Type', 'Policy', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Signature', 'file']) {
    assert.match(source, new RegExp(`= "${name}"`), `S3 field name ${name}`);
  }

  // The S3 POST has its own transport: the uploader never sets a token and never calls APIClient's send.
  const uploader = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/LabelPhoto/LabelPhotoUploader.swift'), 'utf8')).masked;
  assert.doesNotMatch(uploader, /Authorization|Bearer|accessToken|tokenProvider/);
  assert.match(uploader, /transport\.send\(post\.request\(for: body\), body: body\.data\)/);
});

test('offline scan: pending beans write through AccountStore and never send Open Food Facts text (M2-T25)', () => {
  const masked = (path) => lexSwift(readFileSync(join(repoRoot, path), 'utf8')).masked;
  const lookup = masked('ios/Cupmark/Lookup/LookupModel.swift');
  assert.doesNotMatch(lookup, /\bstore\b/, 'the lookup stores nothing: the shelf form saves the pending bean with its entry');
  const editor = masked('ios/Cupmark/Shelf/ShelfEntryEditorModel.swift');
  assert.match(editor, /try add\(try store\.pendingBean\(barcode: barcode\)\)/, 'a barcode scanned offline is kept with its shelf entry');
  const confirmation = masked('ios/Cupmark/Lookup/PendingBeanConfirmation.swift');
  assert.match(confirmation, /store\.confirmOpenFoodFacts\(beanLocalID: prompt\.beanID, picks: self\.picks\)/);
  assert.match(confirmation, /store\.rejectOpenFoodFacts\(beanLocalID: prompt\.beanID\)/);
  assert.match(confirmation, /store\.skipDescription\(beanLocalID: prompt\.beanID\)/);
  // A miss or a rejected hit is described with the pick-list entry, as online (docs/04 F1 step 4).
  assert.match(confirmation, /BeanEntryScreen\(model: entry/);
  assert.match(confirmation, /describing: prompt\.beanID/);
  for (const code of [lookup, confirmation, masked('ios/Cupmark/LabelPhoto/LabelPhotoQueue.swift')]) {
    assert.doesNotMatch(code, /\bcontext\s*\.\s*(insert|save|delete)\(/, 'writes go through AccountStore (ADR 0025)');
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, 'no typed text (invariant 1)');
  }
  // The confirmed create carries the flag and the picks, never the held product's text (ADR 0005).
  const values = masked('ios/Cupmark/Store/StoredValues.swift');
  const create = values.slice(values.indexOf('func apiCreate()'));
  assert.doesNotMatch(create.slice(0, create.indexOf('\n    }\n')), /openFoodFacts(Name|Brand|ImageID)/);
  // The engine looks a pending bean up before anything that names it is sent.
  const engine = masked('ios/Cupmark/Sync/SyncEngine.swift');
  assert.match(engine, /case \(\.bean, \.lookUp\):\s*return try await lookUpBean\(sequence, localID\)/);
  assert.match(masked('ios/Cupmark/Sync/SyncHost.swift'), /queue\.run\(\)/, 'queued label photos run in the idle slot');
});

// ---- Personal statistics (M2-T28, ADR 0027) ----

test('statistics: read-only, offline, no typed text, thresholds only in StatisticsRules (M2-T28)', () => {
  const masked = (path) => lexSwift(readFileSync(join(repoRoot, path), 'utf8')).masked;
  const files = ['PersonalStatistics.swift', 'StatisticsModel.swift', 'StatisticsScreen.swift'].map((name) => `ios/Cupmark/Statistics/${name}`);
  for (const file of files) {
    const code = masked(file);
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\bcontext\s*\.|\.write\s*\{|\bmark(Updated|Deleted)\(|\.add(Brew|Bean|ShelfEntry|Recipe)\(|\.save\(\)/, `${file}: never writes to the store`);
    assert.doesNotMatch(code, /\bapiClient\b|\bAPIClient\b|URLSession/, `${file}: no route (ADR 0027)`);
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
  }
  // The thresholds are defined once; the computation and the screen name them.
  const rules = masked('ios/Cupmark/Statistics/PersonalStatistics.swift');
  for (const name of ['minimumRatedBrews', 'weekCount', 'topFlavourNoteCount', 'meanFractionDigits']) {
    assert.equal(rules.match(new RegExp(`static let ${name}\\s*=`, 'g'))?.length, 1, `${name} is defined once`);
  }
  const screen = masked('ios/Cupmark/Statistics/StatisticsScreen.swift');
  assert.doesNotMatch(screen, /(>=|<=|[<>]|==)\s*\d|prefix\(\s*\d|fractionLength\(/, 'the screen hard-codes no threshold or decimal count');
  assert.doesNotMatch(screen, /\bText\(\s*(?!verbatim:)[^)\n]*\b(name|brand)\b/, 'Open Food Facts text only through Text(verbatim:)');
  assert.match(masked('ios/Cupmark/Shelf/ShelfScreen.swift'), /StatisticsScreen\(store: store/, 'the shelf opens the statistics');
});

// ---- Recipes and one-tap repeat (M2-T27, docs/04 F2) ----

test('recipes: no name, no typed text, written through AccountStore, and one tap from a repeat (M2-T27)', () => {
  const masked = (path) => lexSwift(readFileSync(join(repoRoot, path), 'utf8')).masked;
  const files = ['Brew/BrewStart.swift', 'Brew/BrewStartModel.swift', 'Brew/BrewFlowModel.swift', 'Brew/RecipeViews.swift', 'Store/AccountStore+Recipes.swift']
    .map((name) => `ios/Cupmark/${name}`);
  for (const file of files) {
    const code = masked(file);
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\.rawValue\s*==|rawValue:\s*"/, `${file}: no vocabulary id as a string`);
    // A recipe has no name (invariant 1): nothing names one.
    assert.doesNotMatch(code, /\b(recipeName|nickname|title:\s*String)\b/, `${file}: a recipe has no name`);
  }
  for (const file of files.filter((name) => !name.includes('/Store/'))) {
    assert.doesNotMatch(masked(file), /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: writes go through AccountStore`);
    assert.doesNotMatch(masked(file), /Vocabulary\.(Ranges|Constants)/, `${file}: no range or limit outside BrewDraft`);
  }
  // Every recipe write is inside write { } (ADR 0025, Addendum M2-T35) and queues its operation.
  const store = masked('ios/Cupmark/Store/AccountStore+Recipes.swift');
  for (const name of ['saveRecipe', 'replaceRecipe']) {
    const body = store.slice(store.indexOf(`func ${name}(`));
    assert.match(body.slice(0, body.indexOf('\n    }\n')), /try write \{/, `${name} writes inside write { }`);
  }
  assert.match(store, /try enqueue\(\.create, \.recipe, localID: recipe\.localID\)/);
  assert.match(store, /try enqueueEdit\(of: recipe\)/);
  assert.match(store, /try markDeleted\(recipe\)/);
  // The brew form keeps the recipe in the brew's one save, queued after the brew.
  const model = masked('ios/Cupmark/Brew/BrewFormModel.swift');
  assert.match(model, /try store\.write \{[^}]*try addBrew\(store, brew, entry\) \{[^}]*stageRecipe\(parameters\)/);
  // The rating offer says where it comes from (ADR 0026, Addendum M2-T27).
  const rating = masked('ios/Cupmark/Rating/RatingScreen.swift');
  for (const key of ['ratingUseLast', 'ratingUseLastSameBean', 'ratingUseLastRepeatedBrew']) {
    assert.match(rating, new RegExp(`L10n\\.${key}\\b`), `the offer can say ${key}`);
  }
  // A repeat is one tap: on the shelf row and on the entry's screen.
  assert.match(masked('ios/Cupmark/Shelf/ShelfScreen.swift'), /BrewRoute\(shelfEntryLocalID: row\.id, start: \.lastBrew\)/);
  assert.match(masked('ios/Cupmark/Shelf/ShelfEntryEditorScreen.swift'), /BrewStartSection\(model: repeats/);
  const views = masked('ios/Cupmark/Brew/RecipeViews.swift');
  assert.match(views, /onStart\(model\.route\(\.lastBrew\)\)/);
  assert.match(views, /onStart\(model\.route\(\.recipe\(row\.id\)\)\)/);
  assert.match(views, /\.onDelete\b/, 'recipes can be removed');
});

// ---- Onboarding with consent and Settings (M2-T29, docs/07 D1, ADR 0017) ----

test('onboarding and settings: no typed text, opt-in by default, written through AccountStore (M2-T29)', () => {
  const masked = (path) => lexSwift(readFileSync(join(repoRoot, path), 'utf8')).masked;
  const files = [
    'Onboarding/OnboardingRules.swift',
    'Onboarding/OnboardingModel.swift',
    'Onboarding/OnboardingScreen.swift',
    'Settings/SettingsModel.swift',
    'Settings/SettingsScreen.swift',
  ].map((name) => `ios/Cupmark/${name}`);
  for (const file of files) {
    const code = masked(file);
    assert.doesNotMatch(code, /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(code, /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: writes go through AccountStore`);
    assert.doesNotMatch(code, /\bapiClient\b|\bAPIClient\b|URLSession|putProfile\(/, `${file}: PUT /profile only through the outbox`);
  }
  // Not agreeing is the default, and skipping sends false (D1).
  const model = masked('ios/Cupmark/Onboarding/OnboardingModel.swift');
  assert.match(model, /var agrees = false/);
  assert.match(model, /func skip\(\) \{\s*finish\(agreed: false\)/);
  assert.match(model, /store\.setProfile\(/);
  assert.match(masked('ios/Cupmark/Settings/SettingsModel.swift'), /store\.setProfile\(/);
  // The locale comes from the preferred languages, never a list typed here.
  const rules = masked('ios/Cupmark/Onboarding/OnboardingRules.swift');
  // M2-T32: the rule moved to VocabularyLanguage.resolving, shared with the vocabulary labels.
  assert.match(rules, /VocabularyLanguage\.resolving\(preferredLanguages: preferredLanguages\)/);
  assert.match(masked('ios/Cupmark/Vocabulary/VocabularyItem.swift'), /LanguageCode\.german[\s\S]*LanguageCode\.english[\s\S]*return \.fallback/);
  // The gate sits before the shelf, and Settings is one tap from it.
  const shelf = masked('ios/Cupmark/Shelf/ShelfScreen.swift');
  assert.match(shelf, /OnboardingGate\(store: store, sync: sync\)\s*\{\s*ShelfScreen\(/);
  assert.match(shelf, /NavigationLink\(value: SettingsRoute\(\)\)/);
  assert.match(shelf, /SettingsScreen\(account: sync\?\.account, store: store\)/);
  // A profile made before the server answered is checked first and merged: consent only if
  // both say yes (ADR 0025, Addendum M2-T29).
  const engine = masked('ios/Cupmark/Sync/SyncEngine.swift');
  assert.match(engine, /if checked\.syncState == \.pendingCreate \{[\s\S]*?client\.getProfile\(\)/);
  assert.match(engine, /server\.consent\.contributeToAggregates && localConsent/);
});

// ---- Account deletion (M2-T31, ADR 0017 and its Addendum, ADR 0031) ----

test('account deletion: buttons only, outside Settings, the record first, no sign-out before the 204 (M2-T31)', () => {
  const masked = (path) => lexSwift(readFileSync(join(repoRoot, path), 'utf8')).masked;
  const swiftIn = (dir) => readdirSync(join(repoRoot, dir)).filter((name) => name.endsWith('.swift')).map((name) => `${dir}/${name}`);
  const deletionFiles = swiftIn('ios/Cupmark/AccountDeletion');
  assert.ok(deletionFiles.length >= 4, 'the account deletion sources exist');
  for (const file of deletionFiles) {
    assert.doesNotMatch(masked(file), /\.searchable\b|\bTextField\b|\bTextEditor\b|\bSecureField\b/, `${file}: no typed text (invariant 1)`);
    assert.doesNotMatch(masked(file), /\bcontext\s*\.\s*(insert|save|delete)\(/, `${file}: no store writes`);
  }
  // Every Settings file, not only the two the M2-T29 test lists, stays off the API client: the
  // deletion screen is pushed from there but lives outside it.
  for (const file of swiftIn('ios/Cupmark/Settings')) {
    assert.doesNotMatch(masked(file), /\bapiClient\b|\bAPIClient\b|URLSession|putProfile\(|deleteAccount\(/, `${file}: no API client in Settings`);
  }
  assert.match(masked('ios/Cupmark/Settings/SettingsScreen.swift'), /NavigationLink\s*\{\s*AccountDeletionDestination\(\)/);

  const model = masked('ios/Cupmark/AccountDeletion/AccountDeletionModel.swift');
  const body = (name) => {
    const start = model.indexOf(`func ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const rest = model.slice(start);
    return rest.slice(0, rest.indexOf('\n    }\n'));
  };
  const inOrder = (text, parts, message) => {
    let at = -1;
    for (const part of parts) {
      const next = text.indexOf(part, at + 1);
      assert.ok(next > at, `${message}: ${part}`);
      at = next;
    }
  };
  // The record is saved before the sync is held and before anything is sent.
  inOrder(body('start'), ['try records.save(started)', 'sync?.holdForAccountDeletion()', 'launch()'], 'start');
  // The token is refreshed, then DELETE /account is sent.
  // Right before the request the saved sign-in is checked against the target again, and the
  // request takes only the target's token (review of PR #79).
  inOrder(body('attempt'), ['requests.refreshToken(target)', 'await accountChange(from: target)', 'requests.deleteAccount(target)'], 'attempt');
  assert.match(model, /client\.deleteAccount\(tokens: AccountTokenProvider\(session: session, account: account\)\)/);
  assert.match(model, /refreshToken: \{ account in try await session\.refresh\(for: account\) \}/);
  // No run while a sign-in is under way, and a resume during one starts none.
  assert.match(body('proceed'), /if auth\.isSigningInAgain \{\s*return\s*\}/);
  assert.match(body('resume'), /if auth\.isSigningInAgain \|\| auth\.phase == \.signingIn \{\s*return\s*\}[^]*launch\(\)/);
  // "Delete This Account" only for the account the prompt was worked out for.
  assert.match(body('deleteSignedInAccount'), /guard signedIn == confirmationAccount else/);
  // Two sign-outs only: the cleanup after the 204 (local data, sign-out, then the record), and
  // the explicit "Sign Out" of a different account's session, which deletes nothing (ADR 0031).
  assert.equal((model.match(/\bauth\.signOut\(/g) ?? []).length, 2, 'two sign-outs in the deletion model');
  inOrder(body('finish'), ['localData.remove(', 'auth.signOut(reason: current.wasMovedToAnotherAccount ? .otherAccountDeleted : .accountDeleted)', 'records.delete()'], 'finish');
  const otherSignOut = body('signOutOfSignedInAccount');
  assert.match(otherSignOut, /await auth\.signOut\(\)/);
  assert.doesNotMatch(otherSignOut, /records\.(save|delete)|localData|requests\./, 'signing out of another account keeps the record and deletes nothing');
  // A different account is never deleted without the tap: proceed stops before any attempt, and
  // only deleteSignedInAccount() moves the record.
  inOrder(body('proceed'), ['case .serverDeleted:', 'await finish(current)', 'case .requested:', 'guard signedIn == current.account else', 'state = .confirmDifferentAccount', 'switch await attempt(for: current.account)'], 'proceed');
  assert.doesNotMatch(body('proceed'), /records\.save\(next\)|account: signedIn/, 'proceed never moves the record');
  assert.match(body('deleteSignedInAccount'), /guard state == \.confirmDifferentAccount \|\| state == \.confirmUnreadableRecord/);
  // Every run refreshes first.
  assert.match(body('proceed'), /^[^]*?tokenRefreshed = false/);
  // A record that cannot be decoded is kept and holds (ADR 0031).
  const recordFile = masked('ios/Cupmark/AccountDeletion/AccountDeletionRecord.swift');
  // The Keychain store's load, after the protocol's declaration.
  const load = recordFile.slice(recordFile.lastIndexOf('func load()'), recordFile.lastIndexOf('func save('));
  assert.doesNotMatch(load, /try delete\(\)/, 'an undecodable record is never deleted');
  assert.match(load, /throw AccountDeletionStoreError\.unreadableRecord/);
  // The progress screen warns which account a sign-in deletes, as the sign-in screen does.
  const screen = masked('ios/Cupmark/AccountDeletion/AccountDeletionScreen.swift');
  assert.match(screen, /case \.signInRequired:\s*message\(L10n\.accountDeletionSignInRequired\)\s*message\(L10n\.accountDeletionSignInNote\)/);
  assert.match(masked('ios/Cupmark/Auth/SignInView.swift'), /L10n\.accountDeletionSignInNote/);
  // A cold start resumes after the sign-in is restored.
  assert.match(masked('ios/Cupmark/Auth/AuthGate.swift'), /await auth\?\.start\(\)\s*deletion\?\.resume\(\)/);

  // Nothing is sent while a deletion is recorded: the host opens no store, and every sender asks
  // `maySend(as:)`, which reads the record.
  const host = masked('ios/Cupmark/Sync/SyncHost.swift');
  assert.match(host, /let held = isHeld\(\)\s*let next = held \? nil : requested/);
  assert.match(host, /if let previous = account, !held \{/, 'no label photo is deleted while held');
  assert.match(host, /isHeld: \{ deletions\.holdsSending \}/);
  const live = host.slice(host.indexOf('static func live('), host.indexOf('func switchTo('));
  assert.doesNotMatch(live, /isSignedIn\(as:/, 'the live senders ask maySend(as:)');
  assert.equal((live.match(/session\.maySend\(as:/g) ?? []).length, 3);
  assert.match(masked('ios/Cupmark/LabelPhoto/LabelPhotoFileStore.swift'), /await session\.maySend\(as: candidate\)/);
  assert.match(masked('ios/Cupmark/Auth/AuthSession.swift'), /func maySend\(as account: AccountID\) -> Bool \{\s*!isSendingHeld\(\) && isSignedIn\(as: account\)/);
  // While a deletion runs the signed-in content, with its sign-out button, is replaced.
  assert.match(masked('ios/Cupmark/Auth/AuthGate.swift'), /if let deletion, deletion\.isActive \{\s*AccountDeletionProgressView\(model: deletion\)\s*\} else \{\s*signedIn\(account, auth: auth\)/);
  // A sign-in-required stop of sync signs out with the reason (from the M2-T16 review).
  assert.match(host, /await auth\.signOutAfterServerRefusal\(of: account\)/);
  assert.match(masked('ios/Cupmark/Auth/AuthModel.swift'), /await signOut\(reason: \.signInRequired\)/);
});

// ---- M2-T33: the Xcode project, the UI-test start and the accessibility rules ----

const xcodeProject = await import('./check-xcode-project.mjs');
const accessibility = await import('./check-ios-accessibility.mjs');
const projectText = () => readFileSync(xcodeProject.PROJECT_FILE, 'utf8');
const schemeText = () => readFileSync(xcodeProject.SCHEME_FILE, 'utf8');
const UI_TARGET = 'C0FFEE000000000000000062';

test('check-xcode-project: the committed project and scheme are consistent', () => {
  assert.deepEqual(xcodeProject.checkXcodeProject(projectText(), schemeText()), []);
});

test('check-xcode-project: CupmarkUITests is a UI-test target of the app, built from its own synchronized folder', () => {
  const project = xcodeProject.parsePbxproj(projectText());
  const { objects } = project;
  const target = objects[UI_TARGET];
  assert.equal(target.name, 'CupmarkUITests');
  assert.equal(target.productType, 'com.apple.product-type.bundle.ui-testing');
  assert.equal(objects[target.productReference].path, 'CupmarkUITests.xctest');
  assert.deepEqual(target.fileSystemSynchronizedGroups.map((id) => objects[id].path), ['CupmarkUITests']);
  assert.ok(existsSync(new URL('../ios/CupmarkUITests', import.meta.url)));
  assert.deepEqual(objects[project.rootObject].targets.map((id) => objects[id].name), ['Cupmark', 'CupmarkTests', 'CupmarkUITests']);
  assert.equal(objects[project.rootObject].attributes.TargetAttributes[UI_TARGET].TestTargetID, 'C0FFEE000000000000000010');
  for (const id of objects[target.buildConfigurationList].buildConfigurations) {
    const settings = objects[id].buildSettings;
    assert.equal(settings.TEST_TARGET_NAME, 'Cupmark');
    assert.equal(settings.TEST_HOST, undefined);
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, 'app.cupmark.CupmarkUITests');
    // Swift version, strict concurrency and the deployment target come from the project, as for CupmarkTests.
    assert.equal(settings.SWIFT_VERSION, undefined);
    assert.equal(settings.IPHONEOS_DEPLOYMENT_TARGET, undefined);
  }
});

test('check-xcode-project: the scheme tests both test targets, so the ios job runs the UI tests', () => {
  const testables = xcodeProject.schemeReferences(schemeText()).filter((ref) => ref.testable);
  assert.deepEqual(testables.map((ref) => ref.BlueprintName), ['CupmarkTests', 'CupmarkUITests']);
  assert.equal(testables[1].BlueprintIdentifier, UI_TARGET);
  // The ios job runs the scheme's whole test action: no -only-testing, -skip-testing or test plan.
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /xcodebuild test-without-building \\\s*-project Cupmark\.xcodeproj \\\s*-scheme Cupmark/);
  assert.doesNotMatch(workflow, /-only-testing|-skip-testing|-testPlan/);
});

test('check-xcode-project: finds a missing or doubled id, a missing list, a hosted UI test and a scheme without the UI tests', () => {
  const project = projectText();
  const scheme = schemeText();
  const has = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), problems.join('\n'));
  // An object that is referenced but no longer defined.
  const withoutProxy = project.replace(/\t\tC0FFEE000000000000000066 \/\* PBXContainerItemProxy \*\/ = \{[^}]*\};\n/, '');
  assert.notEqual(withoutProxy, project);
  has(xcodeProject.checkXcodeProject(withoutProxy, scheme), /references C0FFEE000000000000000066, which is not defined/);
  // The same id defined twice.
  const doubled = project.replace(
    '/* End PBXFrameworksBuildPhase section */',
    '\t\tC0FFEE000000000000000064 /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };\n/* End PBXFrameworksBuildPhase section */',
  );
  has(xcodeProject.checkXcodeProject(doubled, scheme), /C0FFEE000000000000000064 is defined twice/);
  // A target without its configuration list.
  const noList = project.replace(/(C0FFEE000000000000000062 \/\* CupmarkUITests \*\/ = \{\n\t\t\tisa = PBXNativeTarget;\n)\t\t\tbuildConfigurationList = [^\n]*\n/, '$1');
  assert.notEqual(noList, project);
  has(xcodeProject.checkXcodeProject(noList, scheme), /target CupmarkUITests has no configuration list/);
  // A UI-test target that is hosted like a unit-test target.
  const hosted = project.replace('TEST_TARGET_NAME = Cupmark;', 'TEST_HOST = "$(BUILT_PRODUCTS_DIR)/Cupmark.app/Cupmark";\n\t\t\t\tTEST_TARGET_NAME = Cupmark;');
  has(xcodeProject.checkXcodeProject(hosted, scheme), /UI-test target must not set TEST_HOST/);
  // A target missing from the targets list.
  const unlisted = project.replace('\t\t\t\tC0FFEE000000000000000062 /* CupmarkUITests */,\n\t\t\t);\n\t\t};\n/* End PBXProject section */', '\t\t\t);\n\t\t};\n/* End PBXProject section */');
  assert.notEqual(unlisted, project);
  has(xcodeProject.checkXcodeProject(unlisted, scheme), /CupmarkUITests is not in the project's targets list/);
  // The scheme without the UI tests, or naming a target that does not exist.
  const start = scheme.indexOf('<TestableReference', scheme.indexOf('CupmarkTests.xctest'));
  const end = scheme.indexOf('</TestableReference>', start) + '</TestableReference>'.length;
  has(xcodeProject.checkXcodeProject(project, scheme.slice(0, start) + scheme.slice(end)), /TestAction does not list the test target CupmarkUITests/);
  has(xcodeProject.checkXcodeProject(project, scheme.replace(`"${UI_TARGET}"`, '"C0FFEE0000000000000000FF"')), /references C0FFEE0000000000000000FF, which is not a target/);
  // A syntax error.
  has(xcodeProject.checkXcodeProject(project.replace('isa = PBXGroup;', 'isa = PBXGroup'), scheme), /expected ;/);
});

test('check-xcode-project: parsePbxproj reads quoted strings, comments and nested lists', () => {
  const parsed = xcodeProject.parsePbxproj('// !$*UTF8*$!\n{ a = "x \\"y\\""; /* c */ b = (1, "two", { c = d; },); e = ../f/g; }');
  assert.deepEqual(parsed, { a: 'x "y"', b: ['1', 'two', { c: 'd' }], e: '../f/g' });
  assert.throws(() => xcodeProject.parsePbxproj('{ a = 1; a = 2; }'), /a is defined twice/);
});

test('check-ios-accessibility: sliders and steppers need a label and a value, hidden picker labels a label', () => {
  const problems = (source) => accessibility.accessibilityProblems(source).map((p) => `${p.line}: ${p.message}`);
  assert.deepEqual(problems('Slider(value: $v, in: 1...10) { Text(t) }\n    .accessibilityLabel(Text(t))\n    .accessibilityValue(Text(v))'), []);
  assert.deepEqual(problems('Slider(value: $v, in: 1...10)\n    .accessibilityLabel(Text(t))'), ['1: Slider has no .accessibilityValue']);
  const stepper = 'Stepper {\n  Text(title)\n} onIncrement: {\n  up()\n} onDecrement: {\n  down()\n}\n.accessibilityLabel(Text(title))\n.accessibilityValue(value)';
  assert.deepEqual(problems(stepper), []);
  assert.deepEqual(problems('Stepper {\n  Text(title)\n} onIncrement: {\n  up()\n} onDecrement: {\n  down()\n}\nif x {\n  y.accessibilityValue(z)\n}'), [
    '1: Stepper has no .accessibilityLabel',
    '1: Stepper has no .accessibilityValue',
  ]);
  assert.deepEqual(problems('Picker(selection: $s) { rows } label: { Text(t) }\n.pickerStyle(.segmented)\n.labelsHidden()'), ['1: Picker hides its label but has no .accessibilityLabel']);
  assert.deepEqual(problems('Picker(selection: $s) { rows } label: { Text(t) }\n.labelsHidden()\n.accessibilityLabel(Text(t))'), []);
  assert.deepEqual(problems('Picker(selection: $s) { rows } label: { Text(t) }'), []);
});

test('check-ios-accessibility: symbols are hidden, labelled, a Label icon, or a labelled button\'s label', () => {
  const problems = (source) => accessibility.accessibilityProblems(source).map((p) => p.message);
  assert.deepEqual(problems('Image(systemName: "a")\n  .font(.title)\n  .accessibilityHidden(true)'), []);
  assert.deepEqual(problems('Label {\n  Text(t)\n} icon: {\n      Image(systemName: "a")\n}'), []);
  assert.deepEqual(problems('Button {\n  go()\n} label: {\n  Image(systemName: "x")\n    .minimumTapTarget()\n}\n.accessibilityLabel(Text(clear))'), []);
  assert.deepEqual(problems('Button {\n  go()\n} label: {\n  Image(systemName: "x")\n}'), ['Image(systemName:) is neither hidden from VoiceOver nor labelled']);
  assert.deepEqual(problems('VStack {\n  Image(systemName: "a")\n  Text(t)\n}'), ['Image(systemName:) is neither hidden from VoiceOver nor labelled']);
});

test('check-ios-accessibility: borderless buttons are at least 44 points, or say why not', () => {
  const problems = (source) => accessibility.accessibilityProblems(source).map((p) => `${p.line}: ${p.message}`);
  const small = 'Button {\n  clear()\n} label: {\n  Text(L10n.clear)\n}\n.buttonStyle(.borderless)';
  assert.deepEqual(problems(small), ['1: borderless Button without .minimumTapTarget() (44 by 44 points)']);
  assert.deepEqual(problems(small.replace('Text(L10n.clear)', 'Text(L10n.clear)\n    .minimumTapTarget()')), []);
  assert.deepEqual(problems(`// Tap target: the index letters stay small.\n${small}`), []);
  const row = 'HStack {\n  Button {\n    a()\n  } label: {\n    Text(x)\n  }\n  Button {\n    b()\n  } label: {\n    Text(y)\n      .minimumTapTarget()\n  }\n}\n.buttonStyle(.borderless)';
  assert.deepEqual(problems(row), ['2: borderless Button without .minimumTapTarget() (44 by 44 points)']);
  assert.deepEqual(problems('Button {\n  a()\n} label: {\n  Text(x)\n}\n.buttonStyle(.bordered)'), []);
});

test('check-ios-accessibility: the UI-test start is only ever compiled in Debug', () => {
  const problems = (source, options) => accessibility.debugOnlyProblems(source, options).map((p) => `${p.line}: ${p.message}`);
  const app = 'init() {\n    #if DEBUG\n    if let launch = UITestLaunch(arguments: args) {\n        return\n    }\n    #endif\n    production()\n}';
  assert.deepEqual(problems(app), []);
  assert.deepEqual(problems('init() {\n    if let launch = UITestLaunch(arguments: args) {}\n}'), [
    '2: mentions the UI-test start outside #if DEBUG: if let launch = UITestLaunch(arguments: args) {}',
  ]);
  assert.equal(problems('#if DEBUG\nlet a = 1\n#else\nlet b = "-CupmarkUITestScreen"\n#endif').length, 1, 'the #else of DEBUG is Release');
  assert.equal(problems('#if os(iOS)\nlet b = uiTestLaunch\n#endif').length, 1, 'another condition is not Debug');
  assert.deepEqual(problems('// A comment.\n\n#if DEBUG\nstruct UITestLaunch {}\n#endif\n', { wholeFile: true }), []);
  assert.deepEqual(problems('import Foundation\n#if DEBUG\nstruct UITestLaunch {}\n#endif', { wholeFile: true }), ['1: the file is not one #if DEBUG ... #endif block']);
  assert.deepEqual(problems('#if DEBUG\nstruct A {}\n#endif\nstruct B {}', { wholeFile: true }), ['1: the file is not one #if DEBUG ... #endif block']);
  assert.equal(problems('#if DEBUG\nstruct A {}').length, 1, 'an unclosed #if');
});

test('check-ios-accessibility: the committed sources pass, and the UI-test start is under UITestSupport only', () => {
  assert.deepEqual(accessibility.checkRepository(), []);
  const supportFiles = readdirSync(accessibility.UI_TEST_SUPPORT_DIR).filter((name) => name.endsWith('.swift'));
  assert.ok(supportFiles.includes('UITestLaunch.swift'), supportFiles.join(', '));
  // The argument's name is written once in the app, in UITestLaunch, and read in CupmarkApp inside #if DEBUG.
  const launchFile = readFileSync(join(accessibility.UI_TEST_SUPPORT_DIR, 'UITestLaunch.swift'), 'utf8');
  assert.match(launchFile, /static let argument = "-CupmarkUITestScreen"/);
  const appFile = readFileSync(join(accessibility.APP_DIR, 'CupmarkApp.swift'), 'utf8');
  assert.match(appFile, /#if DEBUG\n\s*if let launch = UITestLaunch\(arguments: ProcessInfo\.processInfo\.arguments\) \{/);
  assert.match(appFile, /#else\n\s*root\n\s*#endif/, 'Release shows the app root only');
});

test('check-ios-accessibility: the UI tests launch the screens the app knows, with the app\'s argument', () => {
  const rawValues = (source, enumName) => {
    const body = source.slice(source.indexOf(`enum ${enumName}`));
    const block = body.slice(0, body.indexOf('\n    }\n'));
    return [...block.matchAll(/^\s*case ([a-zA-Z]+)(?: = "([^"]+)")?$/gm)].map((m) => m[2] ?? m[1]);
  };
  const app = rawValues(readFileSync(join(accessibility.UI_TEST_SUPPORT_DIR, 'UITestLaunch.swift'), 'utf8'), 'Screen: String');
  const uiTests = readFileSync(new URL('../ios/CupmarkUITests/AccessibilityAuditTests.swift', import.meta.url), 'utf8');
  assert.equal(app.length, 13);
  assert.deepEqual(rawValues(uiTests, 'Screen: String'), app);
  assert.match(uiTests, /"-CupmarkUITestScreen", screen\.rawValue/);
  // Every screen of the acceptance has its own test method, which audits at both sizes.
  for (const screen of ['signIn', 'scannerFallback', 'lookupResult', 'beanEntry', 'shelf', 'brewForm', 'timer', 'rating', 'recipes', 'statistics', 'onboarding', 'settings']) {
    assert.match(uiTests, new RegExp(`auditAtBothSizes\\(\\.${screen}\\b`), screen);
  }
  assert.match(uiTests, /UICTContentSizeCategoryAccessibilityXXXL/);
  assert.match(uiTests, /try app\.performAccessibilityAudit\(for: types\) \{/);
  // No typed text in the UI tests either (invariant 1).
  assert.doesNotMatch(uiTests, /typeText|typeKey/);
});

// ITMS-90022 and ITMS-90713 (TestFlight, build 1): an app without an icon is refused.
test('the app has a 1024 point icon without transparency and names it in the build settings', () => {
  const iosDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios');
  const set = join(iosDir, 'Cupmark', 'Assets.xcassets', 'AppIcon.appiconset');
  const contents = JSON.parse(readFileSync(join(set, 'Contents.json'), 'utf8'));
  const image = contents.images.find((i) => i.size === '1024x1024' && i.idiom === 'universal');
  assert.ok(image?.filename, 'Contents.json lists a universal 1024x1024 image');
  const png = readFileSync(join(set, image.filename));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024, 'width');
  assert.equal(png.readUInt32BE(20), 1024, 'height');
  // IHDR colour type: 2 = RGB, 6 = RGBA. App Store icons must not have an alpha channel.
  assert.equal(png[25], 2, 'colour type RGB, no alpha channel');
  const project = readFileSync(join(iosDir, 'Cupmark.xcodeproj', 'project.pbxproj'), 'utf8');
  const named = project.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g) ?? [];
  assert.equal(named.length, 2, 'Debug and Release of the app target');
});

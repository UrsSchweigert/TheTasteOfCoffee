// Tests for scripts/generate-ios-vocabulary.mjs, scripts/generate-ios-api.mjs,
// scripts/check-ios-strings.mjs and the stage configuration in ios/Config (M2-T9).
// Run: node --test scripts/ios-scripts.test.mjs (needs `npm ci` in contracts/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  const swift = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES });
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
  assert.equal(version, 2);
  const swift = generateSwift({ version, files: loadVocabulary(version), languages: LANGUAGES });
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

/**
 * Fields the v3 rules name that BrewParameters gets when v3 is published
 * (M2-T4); the same list as V3_FIELDS_NOT_IN_API_YET in
 * contracts/test/vocabulary.test.mjs. Until then the draft is generated
 * with them added, as the contract test checks it.
 */
const V3_FIELDS_NOT_IN_API_YET = ['grinder', 'grind_setting'];
const v3BrewFields = () => [...new Set([...brewParameterFields(loadOpenApi()), ...V3_FIELDS_NOT_IN_API_YET])];
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
  assert.throws(() => generateV3(v3Files(), brewParameterFields(loadOpenApi())), /grinder is not a BrewParameters field/);
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

test('the v3 fields are in BrewParameters exactly when v3 is published', () => {
  const published = Object.values(loadVocabulary(3)).every((file) => file.status === 'published');
  for (const field of V3_FIELDS_NOT_IN_API_YET) {
    assert.equal(brewParameterFields(loadOpenApi()).includes(field), published, field);
  }
});

test('the bundled v2 has no grinders and no rules, so its output is unchanged', () => {
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
  // Until M2-T10 (dev) and M6 (prod) the ids are placeholders that StageConfig rejects:
  // uppercase and hyphens are not valid in an app client id or an API id.
  assert.match(readXcconfig('Prod.xcconfig').CUPMARK_APP_CLIENT_ID, /^PLACEHOLDER-/);
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
  assert.match(model, /store\.addBrew\(brew, shelfEntry: entry\)/);
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

  // The brew starts from a shelf entry, in the sheet that then offers its rating (M2-T20).
  const shelf = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfScreen.swift'), 'utf8')).masked;
  assert.match(shelf, /BrewSheet\(store: store, route: route/);
  const editor = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Shelf/ShelfEntryEditorScreen.swift'), 'utf8')).masked;
  assert.match(editor, /BrewSheet\(store: model\.store, route: route/);
  const sheet = lexSwift(readFileSync(join(repoRoot, 'ios/Cupmark/Brew/BrewSheet.swift'), 'utf8')).masked;
  assert.match(sheet, /BrewFormScreen\(\s*store: store,\s*shelfEntry: route\.shelfEntryLocalID/);
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
  assert.match(sheet, /RatingScreen\(store: store, brew: savedBrewID, mode: \.afterBrew/);
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

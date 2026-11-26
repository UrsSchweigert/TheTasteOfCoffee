// Tests for scripts/check-ios-colours.mjs and the colour sets (M2-T41, ADR 0032).
// Run: node --test scripts/ios-colours.test.mjs (no dependencies; runs on Linux CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as colours from './check-ios-colours.mjs';

test('check-ios-colours: colour literals, hex strings, named sets and system tints fail outside Theme', () => {
  const fails = (source, file = 'Screen.swift') =>
    assert.ok(colours.colourProblems(source, file).length >= 1, `should fail: ${source}`);
  fails('Text("a").foregroundStyle(Color(red: 0.4, green: 0.3, blue: 0.2))');
  fails('let c = Color(white: 0.9)');
  fails('let c = Color(hue: 0.1, saturation: 1, brightness: 1)');
  fails('let c = UIColor(red: 1, green: 0, blue: 0, alpha: 1)');
  fails('let c = UIColor.systemBlue');
  fails('let c = Color(.sRGB, red: 1, green: 1, blue: 1)');
  fails('let c = Color(.systemBackground)');
  fails('let c = Color(uiColor: base)');
  fails('let hex = "#6B4428"');
  fails('let hex = "0x6B4428FF"');
  fails('let c = Color("FormBackground")');
  fails('let c = UIColor(named: "Surface")');
  fails('.tint(.indigo)');
  fails('.tint(.brown)');
  fails('.foregroundStyle(.orange)');
  fails('.foregroundColor(Color.blue)');
  fails('.background(.green)');
  fails('let c = Color.purple');
  fails('Text("a").foregroundStyle(.secondary)');
  fails('.foregroundStyle(.tertiary)');
  fails('let c = Color.secondary');
  fails('let s = HierarchicalShapeStyle.secondary');
  fails('.foregroundStyle(.white)');
  fails('.background(Color.black)');
  // The line is reported.
  assert.deepEqual(
    colours.colourProblems('struct A {}\n\nlet c = Color(red: 1, green: 1, blue: 1)\n').map((p) => p.line),
    [3],
  );
});

test('check-ios-colours: Theme names, .red for errors, .primary, .clear, .tint, comments and other strings pass', () => {
  const clean = [
    'Text("a").foregroundStyle(Theme.textSecondary)',
    'Text("a").secondaryText()',
    '.foregroundStyle(.red)',
    '.foregroundStyle(Color.red)',
    '.foregroundStyle(.primary)',
    '.foregroundStyle(.tint)',
    '.tint(.primary)',
    '.tint(Theme.accent)',
    '.background(.regularMaterial)',
    '.background(Color.clear)',
    '// Color(red: 1, green: 0, blue: 0) in a comment, .tint(.indigo), "#6B4428"',
    'let id = "123456"',
    'let hash = "#fragment"',
    'let id = "0x1"',
    'case .orange: return .citrus',
    'let c = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)',
  ].join('\n');
  assert.deepEqual(colours.colourProblems(clean), []);
});

test('check-ios-colours: .white and .black only in the Sign in with Apple button', () => {
  const source = 'Text("a").foregroundStyle(Color.white).background(Color.black, in: shape)';
  assert.ok(colours.colourProblems(source, 'Screen.swift').length > 0);
  assert.deepEqual(colours.colourProblems(source, 'AppleSignInButton.swift'), []);
  assert.deepEqual([...colours.WHITE_BLACK_FILES.keys()], ['AppleSignInButton.swift']);
});

test('check-ios-colours: the committed sources pass, and Theme.swift is the one file that names the colour sets', () => {
  assert.deepEqual(colours.checkRepository(), []);
  const swift = readdirSync(colours.APP_DIR, { recursive: true }).filter((f) => f.endsWith('.swift'));
  const naming = swift.filter((f) => /\bColor\("/.test(readFileSync(join(colours.APP_DIR, f), 'utf8')));
  assert.deepEqual(naming.map((f) => f.split(sep).join('/')), ['Theme/Theme.swift']);
  // Every colour set Theme.swift reads exists, and every set is read.
  const theme = readFileSync(join(colours.APP_DIR, 'Theme', 'Theme.swift'), 'utf8');
  const named = [...theme.matchAll(/Color\("([A-Za-z]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, [...colours.COLOUR_NAMES].sort());
});

test('colour sets: sRGB with light and dark appearances; AccentColor is the global tint', () => {
  for (const name of colours.COLOUR_NAMES) {
    const json = JSON.parse(readFileSync(join(colours.ASSETS_DIR, `${name}.colorset`, 'Contents.json'), 'utf8'));
    const parsed = colours.parseColourSet(json, name);
    assert.deepEqual(Object.keys(parsed).sort(), ['dark', 'light'], name);
    assert.equal(json.colors.length, 2, name);
  }
  const project = readFileSync(join(colours.APP_DIR, '..', 'Cupmark.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.equal(
    (project.match(/ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;/g) ?? []).length,
    2,
    'Debug and Release',
  );
});

const hexOf = (rgb) => rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

test('colour sets: the values of ADR 0032 and every pairing at 4.5:1 in both appearances', () => {
  const sets = colours.readColourSets();
  const expected = {
    AccentColor: ['6B4428', 'E0B27E'],
    OnAccent: ['FFFBF4', '1B120D'],
    FormBackground: ['F4EBDD', '1B120D'],
    ListBackground: ['F7F0E6', '1E1510'],
    Surface: ['FFFBF4', '2A1E17'],
    TextPrimary: ['2B1D14', 'F3E9DC'],
    TextSecondary: ['5E4B3C', 'BFAE9C'],
  };
  for (const [name, [light, dark]] of Object.entries(expected)) {
    assert.equal(hexOf(sets[name].light), light, `${name} light`);
    assert.equal(hexOf(sets[name].dark), dark, `${name} dark`);
  }
  assert.deepEqual(colours.contrastProblems(sets), []);
  assert.equal(colours.PAIRINGS.length, 10);
  for (const [fg, bg, ratios] of colours.PAIRINGS) {
    for (const mode of colours.APPEARANCES) {
      const ratio = colours.contrastRatio(sets[fg][mode], sets[bg][mode]);
      assert.ok(Math.abs(ratio - ratios[mode]) < 0.01, `${fg} on ${bg} (${mode}): ${ratio.toFixed(3)} vs the ADR's ${ratios[mode]}`);
      assert.ok(ratio >= colours.MIN_CONTRAST);
    }
  }
});

test('colour sets: the contrast check fails when a value is changed to a failing one', () => {
  const sets = structuredClone(colours.readColourSets());
  sets.TextSecondary.light = [0.75, 0.7, 0.65];
  sets.AccentColor.dark = sets.FormBackground.dark;
  const problems = colours.contrastProblems(sets);
  assert.ok(problems.some((p) => p.startsWith('TextSecondary on FormBackground (light)')), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('AccentColor on FormBackground (dark)')), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('OnAccent on AccentColor (dark)')), problems.join('\n'));
  // A known ratio: black on white is 21:1.
  assert.equal(Math.round(colours.contrastRatio([0, 0, 0], [1, 1, 1])), 21);
  // A malformed set is an error, not a pass.
  assert.throws(() => colours.parseColourSet({ colors: [] }, 'X'), /no light value/);
  assert.throws(
    () => colours.parseColourSet({ colors: [{ color: { 'color-space': 'display-p3', components: {} } }] }, 'X'),
    /not sRGB/,
  );
});

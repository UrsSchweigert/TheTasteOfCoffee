#!/usr/bin/env node
// Static check of the coffee look (M2-T41, ADR 0032, ios/README.md "Look"). Colours are
// named colour sets in ios/Cupmark/Assets.xcassets and are read in one place,
// ios/Cupmark/Theme/Theme.swift. This fails, in any other Swift file of ios/Cupmark, on:
// - a colour literal: Color(red:, Color(white:, Color(hue:, Color(.sRGB, UIColor(, NSColor(,
//   Color(uiColor:, Color(cgColor:, a colour set read by name (Color("...")) and a hex string
//   ("#6B4428", "0x6B4428");
// - a system colour used as a brand tint or fill: .indigo .blue .orange .green .yellow .pink
//   .purple .brown .teal .mint .cyan .gray .grey, as Color.x or as the argument of a
//   colour modifier (.tint, .foregroundStyle, .foregroundColor, .background, .fill, ...);
// - the system's translucent .secondary/.tertiary/.quaternary as a text colour (ADR 0032, point 3):
//   use .secondaryText() or Theme.textSecondary;
// - .white and .black, except in AppleSignInButton.swift, whose colours Apple's guidelines fix.
// Allowed: .red (error and destructive meaning), .primary, .clear, .tint, Theme.* and the
// modifiers of Theme.swift. UITestSupport/ (Debug only), Generated/ and Theme/ are not checked.
//
// Usage: node scripts/check-ios-colours.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexSwift } from './check-ios-strings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = join(root, 'ios', 'Cupmark');
export const THEME_DIR = join(APP_DIR, 'Theme');
const UNCHECKED_DIRS = [THEME_DIR, join(APP_DIR, 'UITestSupport'), join(APP_DIR, 'Generated')];
/** Files that may use .white and .black, with the reason. */
export const WHITE_BLACK_FILES = new Map([
  ['AppleSignInButton.swift', 'Sign in with Apple is black or white by Apple\'s guidelines'],
]);

const SYSTEM_COLOURS = 'indigo|blue|orange|green|yellow|pink|purple|brown|teal|mint|cyan|gray|grey';
const COLOUR_MODIFIERS =
  'tint|foregroundStyle|foregroundColor|background|overlay|accentColor|fill|stroke|listRowBackground|shadow|border|badge';
const HIERARCHICAL = 'secondary|tertiary|quaternary|quinary';

const RULES = [
  { re: /\b(?:Color|UIColor|NSColor)\s*\(\s*(?:red|white|hue|\.sRGB|\.displayP3|\.sRGBLinear|uiColor|cgColor|nsColor)\b/g, message: 'colour literal' },
  { re: /\b(?:UIColor|NSColor)\s*[(.]/g, message: 'UIKit colour; use Theme' },
  { re: /\bColor\s*\(\s*\./g, message: 'Color(...) built from a system colour; use Theme' },
  { re: new RegExp(`\\bColor\\.(${SYSTEM_COLOURS})\\b`, 'g'), message: 'system colour as a brand colour; use Theme.accent' },
  {
    re: new RegExp(`\\.(?:${COLOUR_MODIFIERS})\\s*\\(\\s*(?:Color)?\\.(${SYSTEM_COLOURS})\\b`, 'g'),
    message: 'system colour as a brand colour; use Theme.accent',
  },
  { re: new RegExp(`\\b(?:Color|HierarchicalShapeStyle)\\.(${HIERARCHICAL})\\b`, 'g'), message: 'system secondary colour; use .secondaryText() or Theme.textSecondary' },
  { re: new RegExp(`\\.foreground(?:Style|Color)\\s*\\(\\s*\\.(${HIERARCHICAL})\\b`, 'g'), message: 'system secondary colour; use .secondaryText() or Theme.textSecondary' },
];
// More ways to write a colour or a brand tint (review of M2-T41).
RULES.push(
  { re: /#colorLiteral\s*\(/g, message: 'colour literal' },
  { re: /\b(?:Linear|Radial|Angular|Elliptical)Gradient\s*\(/g, message: 'gradient; colours come from Theme' },
  { re: /\bColor\s*\.\s*init\s*\(/g, message: 'Color(...) built from values; use Theme' },
  { re: /\b0x[0-9A-Fa-f]{6,8}\b/g, message: 'integer hex colour' },
  { re: new RegExp(`\\.(?:${COLOUR_MODIFIERS}|strokeBorder|listItemTint)\\s*\\(\\s*\\.(${HIERARCHICAL})\\b`, 'g'), message: 'system secondary colour; use .secondaryText() or Theme.textSecondary' },
  // A system colour in a ternary: `c ? .blue : .red`.
  { re: new RegExp(`[?:]\\s*(?:Color)?\\.(${SYSTEM_COLOURS})\\b(?![A-Za-z0-9_(])`, 'g'), message: 'system colour as a brand colour in a condition; use Theme' },
  { re: new RegExp(`\\.(?:strokeBorder|listItemTint)\\s*\\(\\s*(?:Color)?\\.(${SYSTEM_COLOURS})\\b`, 'g'), message: 'system colour as a brand colour; use Theme.accent' },
);
const WHITE_BLACK = [
  /\bColor\.(white|black)\b/g,
  new RegExp(`\\.(?:${COLOUR_MODIFIERS})\\s*\\(\\s*(?:Color)?\\.(white|black)\\b`, 'g'),
];
// A hex colour in a string: "#6B4428", "#6B4428FF", "0x6B4428".
const HEX_STRING = /^"(?:#|0x)(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})"$/;
// A colour set read by name: Color("Name"), UIColor(named: "Name"), Color("Name", bundle:).
const NAMED_COLOUR = /\b(?:Color|UIColor)\s*\(\s*(?:named\s*:\s*)?$/;

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * Colour findings in one Swift file, each `{ line, message }`. `fileName` is the base name,
 * which decides whether .white and .black are allowed.
 */
export function colourProblems(source, fileName = '') {
  const { masked, strings } = lexSwift(source);
  const problems = [];
  const seen = new Set();
  const add = (offset, message) => {
    const key = `${offset}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ line: lineAt(source, offset), message });
  };
  for (const { re, message } of RULES) {
    for (const match of masked.matchAll(re)) add(match.index, `${message}: ${match[0].trim()}`);
  }
  if (!WHITE_BLACK_FILES.has(fileName)) {
    for (const re of WHITE_BLACK) {
      for (const match of masked.matchAll(re)) add(match.index, `.white/.black are for Sign in with Apple only: ${match[0].trim()}`);
    }
  }
  for (const [start, end] of strings) {
    const literal = source.slice(start, end);
    if (HEX_STRING.test(literal)) add(start, `hex colour string ${literal}`);
    if (NAMED_COLOUR.test(masked.slice(Math.max(0, start - 40), start))) add(start, `colour set read by name, ${literal}; use Theme`);
  }
  return problems.sort((a, b) => a.line - b.line);
}

function swiftFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...swiftFiles(path));
    else if (entry.endsWith('.swift')) out.push(path);
  }
  return out;
}

// ---- The palette: named colour sets and their contrast (ADR 0032) ----

export const ASSETS_DIR = join(APP_DIR, 'Assets.xcassets');
export const COLOUR_NAMES = ['AccentColor', 'OnAccent', 'FormBackground', 'ListBackground', 'Surface', 'TextPrimary', 'TextSecondary', 'SwipeAction', 'SwipeActionSecondary', 'ErrorText', 'AverageMarker'];
export const APPEARANCES = ['light', 'dark'];
/** Minimum WCAG 2.x contrast ratio for normal text and for controls the ADR lists. */
export const MIN_CONTRAST = 4.5;
/**
 * Every pairing of ADR 0032, point 2: `[foreground, background]`, with the ratio the ADR
 * records per appearance (a changed value must also change the ADR).
 */
export const PAIRINGS = [
  ['AccentColor', 'FormBackground', { light: 7.16, dark: 9.52 }],
  ['AccentColor', 'ListBackground', { light: 7.48, dark: 9.26 }],
  ['AccentColor', 'Surface', { light: 8.2, dark: 8.36 }],
  ['TextPrimary', 'FormBackground', { light: 13.79, dark: 15.37 }],
  ['TextPrimary', 'ListBackground', { light: 14.4, dark: 14.96 }],
  ['TextPrimary', 'Surface', { light: 15.8, dark: 13.5 }],
  ['TextSecondary', 'FormBackground', { light: 6.98, dark: 8.56 }],
  ['TextSecondary', 'ListBackground', { light: 7.29, dark: 8.33 }],
  ['TextSecondary', 'Surface', { light: 7.99, dark: 7.52 }],
  ['OnAccent', 'AccentColor', { light: 8.2, dark: 9.52 }],
  // The system draws a swipe action's label in white.
  ['White', 'SwipeAction', { light: 8.46, dark: 5.84 }],
  ['White', 'SwipeActionSecondary', { light: 8.24, dark: 6.9 }],
  ['ErrorText', 'FormBackground', { light: 6.24, dark: 9.08 }],
  ['ErrorText', 'ListBackground', { light: 6.51, dark: 8.84 }],
  ['ErrorText', 'Surface', { light: 7.14, dark: 7.97 }],
  // The average marker and its number (M2-T48), drawn beside the slider on the row.
  ['AverageMarker', 'FormBackground', { light: 6.53, dark: 9.96 }],
  ['AverageMarker', 'ListBackground', { light: 6.82, dark: 9.7 }],
  ['AverageMarker', 'Surface', { light: 7.48, dark: 8.75 }],
];

/** `{ light: [r, g, b], dark: [r, g, b] }` (0 to 1) of a colour set's Contents.json, or throws. */
export function parseColourSet(json, name = 'colour set') {
  const out = {};
  for (const entry of json.colors ?? []) {
    const modes = (entry.appearances ?? []).filter((a) => a.appearance === 'luminosity').map((a) => a.value);
    const mode = modes.length === 0 ? 'light' : modes[0];
    if (!APPEARANCES.includes(mode) || modes.length > 1) throw new Error(`${name}: unexpected appearance ${JSON.stringify(entry.appearances)}`);
    const c = entry.color;
    if (!c || c['color-space'] !== 'srgb') throw new Error(`${name}: ${mode} colour is not sRGB`);
    const components = ['red', 'green', 'blue'].map((k) => Number(c.components?.[k]));
    if (components.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error(`${name}: ${mode} components are not 0 to 1 floats`);
    if (Number(c.components.alpha) !== 1) throw new Error(`${name}: ${mode} colour is not opaque`);
    if (out[mode]) throw new Error(`${name}: two ${mode} values`);
    out[mode] = components;
  }
  for (const mode of APPEARANCES) if (!out[mode]) throw new Error(`${name}: no ${mode} value`);
  return out;
}

/** WCAG 2.x relative luminance of sRGB components 0 to 1. */
export function luminance([r, g, b]) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The seven colour sets read from the asset catalogue: `{ Name: { light, dark } }`. */
export function readColourSets(assetsDir = ASSETS_DIR) {
  const sets = {};
  for (const name of COLOUR_NAMES) {
    const file = join(assetsDir, `${name}.colorset`, 'Contents.json');
    sets[name] = parseColourSet(JSON.parse(readFileSync(file, 'utf8')), name);
  }
  // Not a colour set: the colour the system draws swipe action labels in.
  sets.White = { light: [1, 1, 1], dark: [1, 1, 1] };
  return sets;
}

/** Pairings below 4.5:1, in either appearance, as printable lines. */
export function contrastProblems(sets) {
  const problems = [];
  for (const [fg, bg] of PAIRINGS) {
    for (const mode of APPEARANCES) {
      const ratio = contrastRatio(sets[fg][mode], sets[bg][mode]);
      if (ratio < MIN_CONTRAST) problems.push(`${fg} on ${bg} (${mode}) is ${ratio.toFixed(2)}:1, below ${MIN_CONTRAST}:1`);
    }
  }
  return problems;
}

/** Every finding in the committed sources, as printable lines. */
export function checkRepository() {
  const problems = [];
  try {
    problems.push(...contrastProblems(readColourSets()));
  } catch (error) {
    problems.push(`Assets.xcassets: ${error.message}`);
  }
  for (const file of swiftFiles(APP_DIR)) {
    if (UNCHECKED_DIRS.some((dir) => file.startsWith(dir + sep))) continue;
    const base = file.slice(file.lastIndexOf(sep) + 1);
    for (const { line, message } of colourProblems(readFileSync(file, 'utf8'), base)) {
      problems.push(`${relative(root, file)}:${line}: ${message}`);
    }
  }
  return problems;
}

function main() {
  const problems = checkRepository();
  if (problems.length > 0) {
    console.error('check-ios-colours: FAILED (colours are named sets read through ios/Cupmark/Theme/Theme.swift)');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('check-ios-colours: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
// Checks the iOS String Catalog on Linux (backlog M0-T6), so a missing
// translation fails before a Mac ever builds the app:
// - ios/Cupmark/Localizable.xcstrings has source language `en` and, for every
//   key, a translated, non-empty value in each language of contracts/i18n
//   (en and de), with no plural or device variations (none are used yet);
// - every key in ios/Cupmark/L10n.swift is in the catalog, and every catalog
//   key is in L10n.swift (no orphans);
// - no other Swift file passes a string literal to Text, Label, Button,
//   navigationTitle or accessibilityLabel/Hint/Value. UI text goes through
//   L10n; vocabulary labels use Text(verbatim:) with a VocabularyStore label.
//
// Needs Node 22 and `npm ci` in contracts/ (for the language list).
// Usage: node scripts/check-ios-strings.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../contracts/lib/vocabulary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'ios', 'Cupmark');
export const CATALOG_FILE = join(appDir, 'Localizable.xcstrings');
export const KEYS_FILE = join(appDir, 'L10n.swift');

/** Problems with a parsed .xcstrings catalog. */
export function checkCatalog(catalog, languages = LANGUAGES) {
  const problems = [];
  if (catalog?.sourceLanguage !== languages[0]) {
    problems.push(`sourceLanguage is ${JSON.stringify(catalog?.sourceLanguage)}, expected ${languages[0]}`);
  }
  const strings = catalog?.strings;
  if (strings === null || typeof strings !== 'object' || Array.isArray(strings)) {
    problems.push('catalog has no "strings" object');
    return problems;
  }
  for (const [key, entry] of Object.entries(strings)) {
    if (entry?.shouldTranslate === false) problems.push(`${key}: shouldTranslate is false; every UI string is translated`);
    const localizations = entry?.localizations ?? {};
    for (const lang of languages) {
      const unit = localizations[lang]?.stringUnit;
      if (localizations[lang]?.variations !== undefined) {
        problems.push(`${key}: ${lang} uses variations, which this check does not cover yet`);
      } else if (unit === undefined) {
        problems.push(`${key}: no ${lang} value`);
      } else if (unit.state !== 'translated') {
        problems.push(`${key}: ${lang} state is ${JSON.stringify(unit.state)}, expected "translated"`);
      } else if (typeof unit.value !== 'string' || unit.value.trim() === '') {
        problems.push(`${key}: ${lang} value is empty`);
      }
    }
    for (const lang of Object.keys(localizations)) {
      if (!languages.includes(lang)) problems.push(`${key}: unexpected language ${lang}`);
    }
  }
  return problems;
}

/** The string literals of `LocalizedStringKey` members in L10n.swift. */
export function keysInL10n(source) {
  const keys = [];
  const pattern = /:\s*LocalizedStringKey\s*\{\s*"([^"\\]+)"\s*\}/g;
  for (const match of source.matchAll(pattern)) keys.push(match[1]);
  return keys;
}

/** Problems with the keys used in code against the catalog. */
export function checkKeys(codeKeys, catalogKeys) {
  const problems = [];
  const seen = new Set();
  for (const key of codeKeys) {
    if (seen.has(key)) problems.push(`L10n.swift: key ${key} is declared twice`);
    seen.add(key);
    if (!catalogKeys.includes(key)) problems.push(`L10n.swift: key ${key} is not in Localizable.xcstrings`);
  }
  for (const key of catalogKeys) {
    if (!seen.has(key)) problems.push(`Localizable.xcstrings: key ${key} is not used in L10n.swift`);
  }
  return problems;
}

const LITERAL_CALL =
  /\b(Text|Label|Button|Toggle|Picker|Section|navigationTitle|accessibilityLabel|accessibilityHint|accessibilityValue)\(\s*"/g;

/** Lines of a Swift file that pass a string literal straight to a UI text API. */
export function literalUiStrings(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const match of code.matchAll(LITERAL_CALL)) found.push({ line: index + 1, call: match[1] });
  });
  return found;
}

function swiftFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...swiftFiles(path));
    else if (name.endsWith('.swift')) out.push(path);
  }
  return out;
}

function main() {
  const problems = [];
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
  } catch (err) {
    console.error(`check-ios-strings: FAILED. Cannot read ${relative(root, CATALOG_FILE)}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  problems.push(...checkCatalog(catalog).map((p) => `Localizable.xcstrings: ${p}`));
  const catalogKeys = Object.keys(catalog.strings ?? {});
  problems.push(...checkKeys(keysInL10n(readFileSync(KEYS_FILE, 'utf8')), catalogKeys));
  for (const file of swiftFiles(join(root, 'ios'))) {
    if (file === KEYS_FILE) continue;
    for (const { line, call } of literalUiStrings(readFileSync(file, 'utf8'))) {
      problems.push(`${relative(root, file)}:${line}: string literal passed to ${call}; use a key from L10n`);
    }
  }
  if (problems.length > 0) {
    console.error('check-ios-strings: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`check-ios-strings: ok (${catalogKeys.length} keys, languages ${LANGUAGES.join(', ')})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

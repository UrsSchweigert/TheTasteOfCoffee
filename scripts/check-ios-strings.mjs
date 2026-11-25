#!/usr/bin/env node
// Checks the iOS String Catalog on Linux (backlog M0-T6), so a missing
// translation fails before a Mac ever builds the app:
// - ios/Cupmark/Localizable.xcstrings has source language `en` and, for every
//   key, a translated, non-empty value in each language of contracts/i18n
//   (en and de), with no plural or device variations (none are used yet),
//   and `extractionState: manual`, so Xcode does not mark it stale;
// - every key in ios/Cupmark/L10n.swift is in the catalog, and every catalog
//   key is in L10n.swift (no orphans);
// - no other Swift file under ios/ shows a string literal through a UI call
//   (Text, Label, Button, navigationTitle, accessibilityLabel and the others
//   in UI_CALLS): not as the first argument, not on the line after the call,
//   not anywhere inside Text(verbatim:), and not through a name bound to a
//   literal in the same file (`let title = "Hi"` then `Text(title)`). UI text
//   goes through L10n; vocabulary labels use Text(verbatim:) with a
//   VocabularyStore label. See literalUiStrings for the exact rule.
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
    // The catalog is kept by hand with L10n.swift; "manual" stops Xcode from
    // marking an entry stale when its extraction does not find the key.
    if (entry?.extractionState !== 'manual') {
      problems.push(`${key}: extractionState is ${JSON.stringify(entry?.extractionState)}, expected "manual"`);
    }
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

// Calls and modifiers whose first argument is shown to the user. A literal
// there is a LocalizedStringKey that bypasses L10n (or, for Text(verbatim:),
// text that is never translated).
const UI_CALLS = [
  'Text', 'Label', 'Button', 'Toggle', 'Picker', 'Section', 'Menu', 'Link', 'Stepper', 'DatePicker',
  'LabeledContent', 'ContentUnavailableView', 'navigationTitle', 'accessibilityLabel', 'accessibilityHint',
  'accessibilityValue', 'help', 'alert', 'confirmationDialog',
];
const UI_CALL = new RegExp(`\\b(${UI_CALLS.join('|')})\\s*\\(`, 'g');

/**
 * Lexes Swift source just enough for this check. Returns `masked`, the source
 * with every comment and every string literal's contents replaced by spaces
 * (newlines kept, so offsets and line numbers still match), and `strings`,
 * the `[start, end)` offsets of each string literal including its quotes and
 * any raw-string `#`s. Handles line comments, nested block comments, `"..."`, `"""..."""` and
 * `#"..."#`. Interpolations are part of the literal.
 */
export function lexSwift(source) {
  const chars = source.split('');
  const strings = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (chars[k] !== '\n') chars[k] = ' ';
  };
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      const stop = eol === -1 ? n : eol;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') { depth += 1; j += 2; }
        else if (source[j] === '*' && source[j + 1] === '/') { depth -= 1; j += 2; }
        else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    let hashes = 0;
    while (source[i + hashes] === '#') hashes += 1;
    if (source[i + hashes] === '"') {
      const start = i;
      const open = i + hashes;
      const multi = source.startsWith('"""', open);
      const quote = multi ? '"""' : '"';
      const close = quote + '#'.repeat(hashes);
      let j = open + quote.length;
      let end = -1;
      while (j < n) {
        if (hashes === 0 && source[j] === '\\') { j += 2; continue; }
        if (!multi && source[j] === '\n') break;
        if (source.startsWith(close, j)) { end = j + close.length; break; }
        j += 1;
      }
      if (end === -1) end = j;
      strings.push([start, end]);
      blank(open + quote.length, Math.max(open + quote.length, end - close.length));
      i = end;
      continue;
    }
    i += hashes > 0 ? hashes : 1;
  }
  return { masked: chars.join(''), strings };
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const isStringStart = (masked, at) => /^#*"/.test(masked.slice(at, at + 8));

/** Offset just after the parenthesis that closes the one before `from`. */
function closingParen(masked, from) {
  let depth = 1;
  for (let k = from; k < masked.length; k += 1) {
    const ch = masked[k];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return masked.length;
}

/**
 * Names bound directly to a string literal in this file, such as
 * `let title = "Hello"` or `var key: LocalizedStringKey = "a.b"`.
 */
export function literalBindings(masked) {
  const names = new Set();
  const pattern = /\b(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][A-Za-z0-9_.]*\??\s*)?=\s*(?=#*")/g;
  for (const match of masked.matchAll(pattern)) names.add(match[1]);
  return names;
}

/**
 * Places in a Swift file where user-visible text does not come from L10n:
 * - `literal`: a string literal as the first argument of a UI call, also when
 *   it sits on a later line than the call (`Text(\n"Hi")`);
 * - `verbatim`: any string literal inside `Text(verbatim: ...)`, including a
 *   fallback such as `?? "n/a"`; verbatim text is never translated, so it may
 *   only show a vocabulary label or other non-literal value;
 * - `variable`: a name bound to a string literal in the same file (`let t =
 *   "Hi"`) passed as the first argument (plain or `verbatim:`), with or
 *   without `self.`.
 * Comments are ignored. Each finding is `{ line, call, reason }`.
 */
export function literalUiStrings(source) {
  const { masked, strings } = lexSwift(source);
  const bound = literalBindings(masked);
  const found = [];
  for (const match of masked.matchAll(UI_CALL)) {
    const call = match[1];
    const open = match.index + match[0].length;
    let at = open;
    while (/\s/.test(masked[at] ?? '')) at += 1;
    const verbatim = /^verbatim\s*:/.exec(masked.slice(at));
    if (verbatim) {
      at += verbatim[0].length;
      while (/\s/.test(masked[at] ?? '')) at += 1;
    }
    const line = lineAt(source, match.index);
    if (verbatim) {
      const close = closingParen(masked, open);
      if (strings.some(([start]) => start >= at && start < close)) {
        found.push({ line, call, reason: 'verbatim' });
        continue;
      }
    } else if (isStringStart(masked, at)) {
      found.push({ line, call, reason: 'literal' });
      continue;
    }
    const name = /^(?:self\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[),]/.exec(masked.slice(at));
    if (name && bound.has(name[1])) found.push({ line, call, reason: 'variable' });
  }
  return found;
}

const REASONS = {
  literal: 'string literal passed to',
  verbatim: 'string literal inside verbatim',
  variable: 'variable bound to a string literal passed to',
};

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
    for (const { line, call, reason } of literalUiStrings(readFileSync(file, 'utf8'))) {
      problems.push(`${relative(root, file)}:${line}: ${REASONS[reason]} ${call}; use a key from L10n`);
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

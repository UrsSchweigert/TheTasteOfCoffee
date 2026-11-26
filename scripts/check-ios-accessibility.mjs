#!/usr/bin/env node
// Static accessibility and build-safety checks of the iOS sources, on Linux
// (M2-T33). The UI tests' performAccessibilityAudit() runs only on a Mac; these
// rules fail earlier, on what can be read from the source:
// - every Slider and Stepper has .accessibilityLabel and .accessibilityValue in
//   its modifier chain (VoiceOver reads "Aroma, 7.5 of 10");
// - every Picker whose label is hidden (.labelsHidden()) has .accessibilityLabel;
// - every Image(systemName:) is hidden from VoiceOver or labelled, unless it is
//   the icon of a Label (`icon: { ... }`, read through the title) or the whole
//   label of a Button that has .accessibilityLabel;
// - every borderless Button (its own .buttonStyle(.borderless), or one inside a
//   block with that style) makes its label at least 44 by 44 points with
//   .minimumTapTarget(), unless the line before the Button says why not
//   (`// Tap target: ...`);
// - the UI-test start (M2-T33) is Debug only: every file in
//   ios/Cupmark/UITestSupport/ is one `#if DEBUG ... #endif` block, and every
//   mention of it elsewhere in ios/Cupmark and ios/CupmarkTests (the launch
//   argument, a UITest... type, uiTest... names) is inside `#if DEBUG`, never in
//   its #else.
//
// Usage: node scripts/check-ios-accessibility.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexSwift } from './check-ios-strings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = join(root, 'ios', 'Cupmark');
export const UNIT_TEST_DIR = join(root, 'ios', 'CupmarkTests');
export const UI_TEST_SUPPORT_DIR = join(APP_DIR, 'UITestSupport');

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const OPEN = { '(': ')', '{': '}', '[': ']' };

/** Offset just after the bracket that closes the one at `at` (masked text). */
function skipGroup(masked, at) {
  const stack = [];
  for (let k = at; k < masked.length; k += 1) {
    const ch = masked[k];
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return k + 1;
    }
  }
  return masked.length;
}

/** Offset of the bracket that opens the one that closes at `at` (masked text). */
function openingOf(masked, at) {
  let depth = 0;
  for (let k = at; k >= 0; k -= 1) {
    const ch = masked[k];
    if (ch === ')' || ch === '}' || ch === ']') depth += 1;
    else if (OPEN[ch]) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return 0;
}

const skipSpace = (masked, at) => {
  let k = at;
  while (k < masked.length && /\s/.test(masked[k])) k += 1;
  return k;
};

/**
 * The call of `name` at each place it starts (`Slider(`, `Stepper {`, `Button {`):
 * its argument and trailing-closure groups (`(...)`, `{...}`, `label: {...}`),
 * then its modifier chain (`.name(...)`, `.name { ... }`). Each call is
 * `{ start, end, line, groups: [{ label, from, to }], chain: [{ name, from, to }] }`
 * with offsets into the masked source.
 */
export function calls(masked, name) {
  const found = [];
  const pattern = new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*(?=[({])`, 'g');
  for (const match of masked.matchAll(pattern)) {
    let at = match.index + match[0].length;
    const groups = [];
    let label = null;
    for (;;) {
      const k = skipSpace(masked, at);
      if (masked[k] === '(' || masked[k] === '{') {
        const to = skipGroup(masked, k);
        groups.push({ label, from: k, to });
        label = null;
        at = to;
        continue;
      }
      const labelled = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?=\{)/.exec(masked.slice(k, k + 80));
      if (labelled && groups.length > 0) {
        label = labelled[1];
        at = k + labelled[0].length;
        continue;
      }
      break;
    }
    const chain = [];
    for (;;) {
      const k = skipSpace(masked, at);
      const modifier = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(masked.slice(k, k + 80));
      if (!modifier) break;
      let to = k + modifier[0].length;
      for (;;) {
        const g = skipSpace(masked, to);
        if (masked[g] === '(' || (masked[g] === '{' && masked.slice(to, g).indexOf('\n') === -1)) to = skipGroup(masked, g);
        else break;
      }
      chain.push({ name: modifier[1], from: k, to });
      at = to;
    }
    found.push({ start: match.index, end: at, line: lineAt(masked, match.index), groups, chain });
  }
  return found;
}

const hasModifier = (call, name) => call.chain.some((modifier) => modifier.name === name);
const chainText = (masked, call) => call.chain.map((modifier) => masked.slice(modifier.from, modifier.to)).join('');

/** Accessibility findings in one Swift file, each `{ line, rule, message }`. */
export function accessibilityProblems(source) {
  const { masked } = lexSwift(source);
  const rawLines = source.split('\n');
  const problems = [];
  for (const control of ['Slider', 'Stepper']) {
    for (const call of calls(masked, control)) {
      for (const needed of ['accessibilityLabel', 'accessibilityValue']) {
        if (!hasModifier(call, needed)) problems.push({ line: call.line, rule: 'control', message: `${control} has no .${needed}` });
      }
    }
  }
  for (const call of calls(masked, 'Picker')) {
    if (hasModifier(call, 'labelsHidden') && !hasModifier(call, 'accessibilityLabel')) {
      problems.push({ line: call.line, rule: 'control', message: 'Picker hides its label but has no .accessibilityLabel' });
    }
  }
  const buttons = calls(masked, 'Button');
  for (const call of calls(masked, 'Image')) {
    if (!/^Image\s*\(\s*systemName\s*:/.test(masked.slice(call.start, call.start + 40))) continue;
    if (hasModifier(call, 'accessibilityHidden') || hasModifier(call, 'accessibilityLabel')) continue;
    const before = masked.slice(Math.max(0, call.start - 200), call.start);
    if (/icon\s*:\s*\{\s*$/.test(before)) continue;
    const owner = buttons.find((button) => button.groups.some((group) => group.label === 'label' && group.from < call.start && call.start < group.to));
    if (owner && /label\s*:\s*\{\s*$/.test(before) && hasModifier(owner, 'accessibilityLabel')) continue;
    problems.push({ line: call.line, rule: 'image', message: 'Image(systemName:) is neither hidden from VoiceOver nor labelled' });
  }
  // Blocks styled borderless as a whole: `{ ... }` or `( ... )` right before `.buttonStyle(.borderless)`.
  const borderlessBlocks = [];
  for (const match of masked.matchAll(/\.buttonStyle\s*\(\s*\.borderless\s*\)/g)) {
    if (buttons.some((button) => button.chain.some((modifier) => modifier.from === match.index))) continue;
    let k = match.index - 1;
    while (k >= 0 && /\s/.test(masked[k])) k -= 1;
    if (masked[k] === '}' || masked[k] === ')') borderlessBlocks.push([openingOf(masked, k), k]);
  }
  for (const call of buttons) {
    const own = call.chain.some((modifier) => modifier.name === 'buttonStyle' && /\.borderless/.test(masked.slice(modifier.from, modifier.to)));
    const inBlock = borderlessBlocks.some(([from, to]) => from < call.start && call.start < to);
    if (!own && !inBlock) continue;
    const exempt = /\/\/\s*Tap target:/.test(rawLines[call.line - 2] ?? '') || /\/\/\s*Tap target:/.test(rawLines[call.line - 3] ?? '');
    if (exempt) continue;
    const label = call.groups.find((group) => group.label === 'label') ?? call.groups.at(-1);
    const text = label ? masked.slice(label.from, label.to) : '';
    if (!/\.minimumTapTarget\s*\(\s*\)/.test(text) && !/\.minimumTapTarget\s*\(\s*\)/.test(chainText(masked, call))) {
      problems.push({ line: call.line, rule: 'tap-target', message: 'borderless Button without .minimumTapTarget() (44 by 44 points)' });
    }
  }
  return problems;
}

const DEBUG_ONLY = /CupmarkUITest|\b(?:UITest|uiTest)[A-Z][A-Za-z0-9_]*/;

/**
 * Lines of `source` that mention the UI-test start outside an `#if DEBUG` block
 * (or in its `#else`). With `wholeFile`, also requires the whole file to be one
 * `#if DEBUG` block: nothing but comments and blank lines outside it.
 */
export function debugOnlyProblems(source, { wholeFile = false } = {}) {
  const problems = [];
  const stack = [];
  const lines = source.split('\n');
  let firstCode = -1;
  let lastCode = -1;
  let blockClosedAt = -1;
  lines.forEach((text, index) => {
    const line = index + 1;
    const trimmed = text.trim();
    const directive = /^#(if|elseif|else|endif)\b\s*(.*)$/.exec(trimmed);
    if (trimmed !== '' && !trimmed.startsWith('//')) {
      if (firstCode === -1) firstCode = line;
      lastCode = line;
    }
    if (directive) {
      const [, kind, condition] = directive;
      if (kind === 'if') stack.push({ debug: condition.trim() === 'DEBUG', inElse: false, line });
      else if (kind === 'elseif' || kind === 'else') {
        const top = stack.at(-1);
        if (top) top.inElse = true;
        else problems.push({ line, message: `#${kind} without #if` });
      } else {
        const top = stack.pop();
        if (!top) problems.push({ line, message: '#endif without #if' });
        else if (stack.length === 0 && top.line === firstCode) blockClosedAt = line;
      }
      return;
    }
    const inDebug = stack.some((frame) => frame.debug && !frame.inElse);
    if (!inDebug && DEBUG_ONLY.test(text)) problems.push({ line, message: `mentions the UI-test start outside #if DEBUG: ${trimmed}` });
  });
  if (stack.length > 0) problems.push({ line: stack.at(-1).line, message: '#if without #endif' });
  if (wholeFile) {
    const opener = /^#if\s+DEBUG\s*$/.test((lines[firstCode - 1] ?? '').trim());
    if (!opener || blockClosedAt !== lastCode) problems.push({ line: Math.max(firstCode, 1), message: 'the file is not one #if DEBUG ... #endif block' });
  }
  return problems;
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

/** Every finding of both checks in the committed sources, as printable lines. */
export function checkRepository() {
  const problems = [];
  const supportFiles = swiftFiles(UI_TEST_SUPPORT_DIR);
  if (supportFiles.length === 0) problems.push('ios/Cupmark/UITestSupport has no Swift file');
  for (const file of swiftFiles(APP_DIR)) {
    const source = readFileSync(file, 'utf8');
    const name = relative(root, file);
    if (!file.includes(`${sep}Generated${sep}`)) {
      for (const { line, message } of accessibilityProblems(source)) problems.push(`${name}:${line}: ${message}`);
    }
    const wholeFile = file.startsWith(UI_TEST_SUPPORT_DIR + sep);
    for (const { line, message } of debugOnlyProblems(source, { wholeFile })) problems.push(`${name}:${line}: ${message}`);
  }
  for (const file of swiftFiles(UNIT_TEST_DIR)) {
    for (const { line, message } of debugOnlyProblems(readFileSync(file, 'utf8'))) problems.push(`${relative(root, file)}:${line}: ${message}`);
  }
  return problems;
}

function main() {
  const problems = checkRepository();
  if (problems.length > 0) {
    console.error('check-ios-accessibility: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('check-ios-accessibility: ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

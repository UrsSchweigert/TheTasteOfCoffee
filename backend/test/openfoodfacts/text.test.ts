// Cleaning untrusted Open Food Facts text (M1-T4b): trimming, white space,
// control characters, cuts in code points (not UTF-16 units) at grapheme
// boundaries, and the contract's limits.
import { describe, expect, it } from 'vitest';
import { OpenFoodFactsProductSchema } from '../../src/generated/contract.ts';
import { BRAND_MAX_CODE_POINTS, NAME_MAX_CODE_POINTS, cleanText, firstBrand } from '../../src/openfoodfacts/text.ts';
import { parseOpenApi, OPENAPI_FILE } from '../../scripts/codegen/paths.ts';
import { readFileSync } from 'node:fs';

const codePoints = (value: string): number => Array.from(value).length;

describe('cleanText', () => {
  it('the limits are the contract maxLength of name and brand', () => {
    const contract = parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')) as {
      components: { schemas: { OpenFoodFactsProduct: { properties: Record<string, { maxLength?: number }> } } };
    };
    const properties = contract.components.schemas.OpenFoodFactsProduct.properties;
    expect(properties.name?.maxLength).toBe(NAME_MAX_CODE_POINTS);
    expect(properties.brand?.maxLength).toBe(BRAND_MAX_CODE_POINTS);
  });

  it.each([
    ['plain text', 'Ethiopia Guji', 'Ethiopia Guji'],
    ['leading and trailing spaces', '   Kenya AA \t', 'Kenya AA'],
    ['inner runs of white space', 'Kenya \t\t  AA', 'Kenya AA'],
    ['line breaks', 'Kenya\r\nAA\nPeaberry', 'Kenya AA Peaberry'],
    ['line and paragraph separators', 'Kenya AA x', 'Kenya AA x'],
    ['no-break and ideographic spaces', ' Kenya　AA ', 'Kenya AA'],
    ['NUL and other C0 controls', 'Ke\u0000ny\u0007a\u001b[31m', 'Kenya[31m'],
    ['DEL and C1 controls', 'Ke\u007fny\u0085a\u009b', 'Keny a'],
    ['a byte-order mark', '﻿Kenya', 'Kenya'],
    ['bidi overrides and isolates', 'abc‮dcba‬ ⁦x⁩', 'abcdcba x'],
    ['a lone high surrogate', 'Kenya\ud800', 'Kenya'],
    ['a lone low surrogate', '\udc00Kenya', 'Kenya'],
    ['markup, kept as plain data', '<b>Guji</b> & "co"', '<b>Guji</b> & "co"'],
    ['emoji, kept', 'Café ☕ 🇪🇹', 'Café ☕ 🇪🇹'],
    ['decomposed accents, composed (NFC)', 'Café', 'Café'],
  ])('%s', (_name, input, expected) => {
    expect(cleanText(input, NAME_MAX_CODE_POINTS)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['only white-space controls', '\t\r\n '],
    ['only controls', '\u0000\u0001‮﻿'],
    ['a number', 42],
    ['null', null],
    ['an array', ['Kenya']],
    ['an object', { name: 'Kenya' }],
  ])('%s is absent', (_name, input) => {
    expect(cleanText(input, NAME_MAX_CODE_POINTS)).toBeUndefined();
  });

  it('cuts in code points, not UTF-16 units: 150 astral characters fit, 151 are cut to 150', () => {
    const coffee = '\u{1F375}'; // two UTF-16 units, one code point
    const fits = coffee.repeat(150);
    expect(fits.length).toBe(300);
    expect(cleanText(fits, NAME_MAX_CODE_POINTS)).toBe(fits);
    const cut = cleanText(coffee.repeat(151), NAME_MAX_CODE_POINTS);
    expect(cut).toBe(fits);
    expect(OpenFoodFactsProductSchema.safeParse({ name: cut }).success).toBe(true);
  });

  it('cuts at the limit and trims what the cut leaves', () => {
    expect(cleanText('a'.repeat(200), NAME_MAX_CODE_POINTS)).toBe('a'.repeat(150));
    expect(cleanText(`${'a'.repeat(149)} bcd`, NAME_MAX_CODE_POINTS)).toBe('a'.repeat(149));
    expect(cleanText('b'.repeat(101), BRAND_MAX_CODE_POINTS)).toBe('b'.repeat(100));
  });

  it('does not split an emoji sequence at the cut', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 5 code points, one grapheme
    const text = `${'a'.repeat(147)}${family}`;
    expect(cleanText(text, NAME_MAX_CODE_POINTS)).toBe('a'.repeat(147));
    const flag = '\u{1F1EA}\u{1F1F9}';
    expect(cleanText(`${'a'.repeat(149)}${flag}`, NAME_MAX_CODE_POINTS)).toBe('a'.repeat(149));
  });

  it('a single grapheme over the limit is cut by code points', () => {
    const zalgo = `a${'́'.repeat(300)}`;
    const cut = cleanText(zalgo, NAME_MAX_CODE_POINTS);
    expect(cut === undefined ? 0 : codePoints(cut)).toBe(150);
  });

  it('whatever it returns passes the contract schema', () => {
    const inputs = ['  x  ', '\u{1F375}'.repeat(400), `${'\u0000'.repeat(10)}y`, `a${'́'.repeat(300)}`, 'é'.repeat(500)];
    for (const input of inputs) {
      const name = cleanText(input, NAME_MAX_CODE_POINTS);
      const brand = cleanText(input, BRAND_MAX_CODE_POINTS);
      expect(OpenFoodFactsProductSchema.safeParse({ ...(name === undefined ? {} : { name }), ...(brand === undefined ? {} : { brand }) }).success).toBe(true);
    }
  });
});

describe('firstBrand', () => {
  it.each([
    ['one brand', 'Rösterei Beispiel', 'Rösterei Beispiel'],
    ['the first of a list', 'Acme Coffee, Acme, Big Group', 'Acme Coffee'],
    ['the first non-empty entry', ' , ,Acme', 'Acme'],
    ['cut to 100 code points', `${'b'.repeat(120)},c`, 'b'.repeat(100)],
  ])('%s', (_name, input, expected) => {
    expect(firstBrand(input)).toBe(expected);
  });

  it.each([['empty', ''], ['only commas', ' , , '], ['an array', ['Acme']], ['a number', 7], ['undefined', undefined]])('%s is absent', (_name, input) => {
    expect(firstBrand(input)).toBeUndefined();
  });
});

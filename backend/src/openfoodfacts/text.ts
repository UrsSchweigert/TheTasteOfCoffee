// Untrusted Open Food Facts text (ADR 0005; contracts/openapi.yaml,
// OpenFoodFactsProduct): the only free text the API ever returns. It comes from
// a third party, so it is cleaned before it is stored and never logged.
//
// What `cleanText` does, in order:
// 1. Anything but a string is absent.
// 2. Unicode NFC, so one visible text has one stored form.
// 3. Line breaks, tabs and the other white-space controls (C0, NEL, U+2028,
//    U+2029) become a space; every other control character (Unicode Cc), lone
//    surrogates, the byte-order mark and the bidirectional embedding, override
//    and isolate controls (U+202A to U+202E, U+2066 to U+2069, which can make
//    text display in another order than it is stored) are removed.
// 4. Runs of white space become one space, and the ends are trimmed.
// 5. Cut to `maxCodePoints` code points (the contract's maxLength, which JSON
//    Schema counts in code points), at a grapheme boundary where one exists,
//    so an emoji sequence or a letter with its accents is not split; a single
//    grapheme longer than the limit is cut by code points. Trimmed again.
// 6. Empty is absent.

/** maxLength of OpenFoodFactsProduct.name in contracts/openapi.yaml. */
export const NAME_MAX_CODE_POINTS = 150;
/** maxLength of OpenFoodFactsProduct.brand in contracts/openapi.yaml. */
export const BRAND_MAX_CODE_POINTS = 100;

const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
const REMOVED = /[\p{Cc}\uFEFF\u202A-\u202E\u2066-\u2069]|[\uD800-\uDFFF]/gu;
const SPACES = /\s+/gu;

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

function codePoints(value: string): number {
  return Array.from(value).length;
}

function cut(value: string, maxCodePoints: number): string {
  if (codePoints(value) <= maxCodePoints) return value;
  let result = '';
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = codePoints(segment);
    if (used + size > maxCodePoints) break;
    result += segment;
    used += size;
  }
  return result === '' ? Array.from(value).slice(0, maxCodePoints).join('') : result;
}

/** The cleaned text, or undefined if `value` is not a string or nothing is left (see the file comment). */
export function cleanText(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Removal comes before NFC: normalize() keeps lone surrogates, and controls must not combine with anything.
  const text = value
    .replace(WHITESPACE_CONTROLS, ' ')
    .replace(REMOVED, '')
    .normalize('NFC')
    .replace(SPACES, ' ')
    .trim();
  const result = cut(text, maxCodePoints).trim();
  return result === '' ? undefined : result;
}

/** The first entry of the Open Food Facts `brands` field (a comma-separated list), cleaned. */
export function firstBrand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  for (const entry of value.split(',')) {
    const brand = cleanText(entry, BRAND_MAX_CODE_POINTS);
    if (brand !== undefined) return brand;
  }
  return undefined;
}

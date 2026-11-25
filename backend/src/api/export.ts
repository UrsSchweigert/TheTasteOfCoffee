// GET /export (task M1-T6; ADR 0017, point 5; contracts/openapi.yaml,
// exportData): every item of the caller as one CSV file.
//
// Format, exactly as the contract's operation description says:
// - UTF-8 without a byte order mark, RFC 4180, every field (the header too)
//   in double quotes, CRLF after every row including the last;
// - the header is EXPORT_CSV_COLUMNS and the rows come in
//   EXPORT_CSV_ITEM_TYPES order, each type sorted by ascending id; both lists
//   are generated from the contract's `x-csv-columns` and `x-csv-item-types`
//   (src/generated/export.ts), never written here;
// - a resource is flattened with the contract's rule: the wrapper objects
//   `values`, `parameters`, `rating` and `consent` add their fields with no
//   prefix, any other object (`scores`, `intensities`, keyed by vocabulary
//   ids) adds them as `<object>_<field>`; an array is its ids joined by `;`;
//   booleans are `true` or `false`, numbers their shortest decimal form;
// - a column a row does not have is `""`.
// Every value is an id, a vocabulary id, a number, a boolean, a date or a
// timestamp. A value that holds a double quote, comma, CR or LF (or `;` in a
// list), a number with an exponent, or a flattened field that is not a column
// cannot happen with the stored schemas; if it ever did, the export fails
// with ExportShapeError (500) rather than write a broken file.
//
// Size: the Lambda response limit is 6 MB for the whole response. The file
// may be at most MAX_EXPORT_BYTES (5 MiB), which leaves room for headers and
// the JSON envelope; above it the route answers 500 `ExportTooLarge`. A brew
// row is about 300 to 400 bytes (36 quoted fields, ids of 26 characters), so
// that is about 13,000 brews, years of daily brewing.
import type { Brew, Profile, Recipe, ShelfEntry } from '../generated/contract.ts';
import { EXPORT_CSV_COLUMNS, EXPORT_CSV_ITEM_TYPES } from '../generated/export.ts';
import type { ExportCsvColumn, ExportCsvItemType } from '../generated/export.ts';
import type { ExportItems } from '../repository/index.ts';
import type { ApiResult } from './http.ts';

/** The largest CSV body served, in bytes; the Lambda limit is 6 MB for the whole response. */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;

export const EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8; header=present';

/** Objects that add their fields with no prefix (contracts/openapi.yaml, exportData; contracts/README.md, CSV export). */
const WRAPPERS: ReadonlySet<string> = new Set(['values', 'parameters', 'rating', 'consent']);

const COLUMNS: ReadonlySet<string> = new Set(EXPORT_CSV_COLUMNS);
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
/** Characters a field may never hold, so no field needs escaping. */
const UNSAFE = /["\r\n,]/;

export class ExportShapeError extends Error {
  public override readonly name = 'ExportShapeError';
}

export class ExportTooLargeError extends Error {
  public override readonly name = 'ExportTooLargeError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (typeof value === 'string') {
    if (UNSAFE.test(value)) throw new ExportShapeError('a value holds a character CSV would need to escape');
    return value;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    const text = String(value);
    if (!NUMBER.test(text)) throw new ExportShapeError('a number has no plain decimal form');
    return text;
  }
  throw new ExportShapeError('a value is not a string, number or boolean');
}

/** One resource's fields under their column names, by the contract's flattening rule. */
export function flatten(resource: Record<string, unknown>): Map<ExportCsvColumn, string> {
  const fields = new Map<ExportCsvColumn, string>();
  const put = (name: string, value: string): void => {
    if (!COLUMNS.has(name)) throw new ExportShapeError('a field has no column');
    const column = name as ExportCsvColumn;
    if (fields.has(column)) throw new ExportShapeError('two fields map to one column');
    fields.set(column, value);
  };
  const walk = (object: Record<string, unknown>, prefix: string): void => {
    for (const [name, value] of Object.entries(object)) {
      if (value === undefined) continue;
      if (isRecord(value)) {
        walk(value, WRAPPERS.has(name) ? prefix : `${prefix}${name}_`);
      } else if (Array.isArray(value)) {
        const ids = value.map((entry) => {
          if (typeof entry !== 'string' || entry.includes(';')) throw new ExportShapeError('a list holds something other than ids');
          return scalar(entry);
        });
        put(`${prefix}${name}`, ids.join(';'));
      } else {
        put(`${prefix}${name}`, scalar(value));
      }
    }
  };
  walk(resource, '');
  return fields;
}

type Row = ReadonlyMap<ExportCsvColumn, string>;

function row(itemType: ExportCsvItemType, resource: Record<string, unknown>): Row {
  const fields = flatten(resource);
  if (fields.has('item_type')) throw new ExportShapeError('a resource has a field item_type');
  return new Map([['item_type', itemType], ...fields]);
}

function line(values: readonly string[]): string {
  return `${values.map((value) => `"${value}"`).join(',')}\r\n`;
}

/**
 * The rows of each item type. A Record over the generated item types, so a
 * new type in the contract fails the type check until it is exported.
 */
function rowsByType(items: ExportItems): Record<ExportCsvItemType, () => Row[]> {
  return {
    profile: () => (items.profile === undefined ? [] : [row('profile', items.profile satisfies Profile)]),
    shelf_entry: () => items.shelfEntries.map((entry: ShelfEntry) => row('shelf_entry', entry)),
    brew: () => items.brews.map((brew: Brew) => row('brew', brew)),
    recipe: () => items.recipes.map((recipe: Recipe) => row('recipe', recipe)),
    // The user-side PHOTO# item; no route returns it as JSON (ADR 0016).
    label_photo: () => items.labelPhotos.map((photo) => row('label_photo', { photo_id: photo.photoId, bean_id: photo.beanId })),
  };
}

/**
 * The CSV file of `items`. Rows of each type are sorted by ascending id here
 * as well, so the order never depends on the store. Throws ExportShapeError
 * or ExportTooLargeError.
 */
export function exportCsv(items: ExportItems, maxBytes = MAX_EXPORT_BYTES): string {
  const sorted: ExportItems = {
    ...(items.profile === undefined ? {} : { profile: items.profile }),
    shelfEntries: [...items.shelfEntries].sort((a, b) => compare(a.shelf_entry_id, b.shelf_entry_id)),
    brews: [...items.brews].sort((a, b) => compare(a.brew_id, b.brew_id)),
    recipes: [...items.recipes].sort((a, b) => compare(a.recipe_id, b.recipe_id)),
    labelPhotos: [...items.labelPhotos].sort((a, b) => compare(a.photoId, b.photoId)),
  };
  const byType = rowsByType(sorted);
  const parts = [line(EXPORT_CSV_COLUMNS)];
  // Every character is ASCII (ids, vocabulary ids, digits), so length is the byte count; checked on bytes anyway below.
  let size = parts[0]?.length ?? 0;
  for (const itemType of EXPORT_CSV_ITEM_TYPES) {
    for (const fields of byType[itemType]()) {
      const text = line(EXPORT_CSV_COLUMNS.map((column) => fields.get(column) ?? ''));
      size += text.length;
      if (size > maxBytes) throw new ExportTooLargeError('the export is over the response limit');
      parts.push(text);
    }
  }
  const csv = parts.join('');
  if (Buffer.byteLength(csv, 'utf8') > maxBytes) throw new ExportTooLargeError('the export is over the response limit');
  return csv;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The 200 response: the CSV as UTF-8 text, never cached. */
export function csvResponse(csv: string): ApiResult {
  return {
    statusCode: 200,
    headers: { 'content-type': EXPORT_CONTENT_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: csv,
    isBase64Encoded: false,
  };
}

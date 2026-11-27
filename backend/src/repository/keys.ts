// Every key format of the data model (docs/05-system-design.md, Data model, and
// ADR 0010). Builders validate each part before it goes into a key: ids must be
// ULIDs, barcodes digits, methods and other facet values vocabulary ids, dates
// real dates. A bad part throws InvalidKeyError and is never interpolated, so no
// input can add a `#` or name another partition.
//
// User-scoped keys take a `UserId`, which only `userIdFromEvent` can make.
import type { z } from 'zod';
import { UserId } from '../auth/user-id.ts';
import {
  BarcodeSchema,
  CalendarDateSchema,
  IdSchema,
  MethodSchema,
  OriginSchema,
  PriceBandSchema,
  ProcessSchema,
  RoastLevelSchema,
  TimestampSchema,
} from '../generated/contract.ts';
import type { Method, Origin, PriceBand, Process, RoastLevel } from '../generated/contract.ts';
import { InvalidKeyError } from './errors.ts';

export interface Key {
  readonly pk: string;
  readonly sk: string;
}

/** The sparse review-queue index attributes of an unverified bean. */
export interface ReviewQueueKey {
  readonly gsi1pk: string;
  readonly gsi1sk: string;
}

export const PREFIX = {
  user: 'USER#',
  shelf: 'SHELF#',
  brew: 'BREW#',
  brewRef: 'BREWID#',
  recipe: 'RECIPE#',
  bean: 'BEAN#',
  barcode: 'BARCODE#',
  aggregate: 'AGG#',
  aggregateMethod: 'AGG#METHOD#',
  ranking: 'RANK#',
  lookups: 'LOOKUPS#',
  labelPhoto: 'PHOTO#',
  labelPhotoPending: 'PHOTO_PENDING#',
  labelPhotoCount: 'BEANPHOTOS#',
  labelPhotoUploads: 'PHOTO_UPLOADS#',
  deletedAccount: 'DELETED#',
} as const;

export const SORT_KEY = {
  profile: 'PROFILE',
  beanMeta: 'META',
  barcodeTarget: 'BEAN',
  openFoodFactsCache: 'OFF',
  aggregateAll: 'AGG#ALL',
  tombstone: 'META',
} as const;

export const REVIEW_QUEUE_PK = 'REVIEW#UNVERIFIED';

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** `Date.prototype.toISOString` for years 0000 to 9999: always 24 characters. */
const UTC_MS = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const FIXED_WIDTH_UTC = new RegExp(`^${UTC_MS}$`);

// ---- validation of key parts ----

function id(value: unknown, what: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidKeyError(`invalid ${what}`);
  return parsed.data;
}

function userPart(user: unknown): string {
  if (!UserId.is(user)) throw new InvalidKeyError('a UserId from userIdFromEvent is required');
  return user.value;
}

/**
 * The canonical form of a barcode (contracts/openapi.yaml, `Barcode`): EAN-13, or
 * UPC-A with a leading 0, so both forms of one product give one key. The GS1
 * check digit must be right. Throws InvalidKeyError, without echoing the input.
 */
export function canonicalBarcode(value: unknown): string {
  const parsed = BarcodeSchema.safeParse(value);
  if (!parsed.success) throw new InvalidKeyError('invalid barcode');
  const ean13 = parsed.data.length === 12 ? `0${parsed.data}` : parsed.data;
  const digits = Array.from(ean13, Number);
  // GS1: weights 1 and 3 alternate from the left over the first 12 digits.
  const sum = digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  if ((10 - (sum % 10)) % 10 !== digits[12]) throw new InvalidKeyError('invalid barcode check digit');
  return ean13;
}

function method(value: unknown): Method {
  const parsed = MethodSchema.safeParse(value);
  if (!parsed.success) throw new InvalidKeyError('invalid method');
  return parsed.data;
}

function calendarDate(value: unknown, what: string): string {
  const parsed = CalendarDateSchema.safeParse(value);
  if (!parsed.success) throw new InvalidKeyError(`invalid ${what}`);
  return parsed.data;
}

/**
 * A contract `Timestamp` (any RFC 3339 offset, up to 9 fraction digits) as
 * fixed-width UTC with milliseconds, so keys sort by time as strings.
 */
export function fixedWidthUtc(value: unknown, what = 'timestamp'): string {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) throw new InvalidKeyError(`invalid ${what}`);
  return utcOf(new Date(parsed.data), what);
}

/** A Date as fixed-width UTC (`toISOString()`), rejecting years outside 0000 to 9999. */
export function utcOf(date: Date, what = 'timestamp'): string {
  if (Number.isNaN(date.getTime())) throw new InvalidKeyError(`invalid ${what}`);
  const iso = date.toISOString();
  if (!FIXED_WIDTH_UTC.test(iso)) throw new InvalidKeyError(`${what} out of range`);
  return iso;
}

// ---- user partition ----

/** `USER#<sub>`: the partition of the caller, derived from the verified token only. */
export function userPk(user: UserId): string {
  return `${PREFIX.user}${userPart(user)}`;
}

export function profileKey(user: UserId): Key {
  return { pk: userPk(user), sk: SORT_KEY.profile };
}

/** ADR 0010: the shelf entry id is the sort key; bean id and purchase date are attributes. */
export function shelfEntryKey(user: UserId, shelfEntryId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.shelf}${id(shelfEntryId, 'shelf entry id')}` };
}

/** ADR 0010: `BREW#<brewedAt UTC>#<brewId>`, so a query lists brews newest first. */
export function brewKey(user: UserId, brewedAt: string, brewId: string): Key {
  return { pk: userPk(user), sk: brewSortKey(brewedAt, brewId) };
}

export function brewSortKey(brewedAt: string, brewId: string): string {
  return `${PREFIX.brew}${fixedWidthUtc(brewedAt, 'brew time')}#${id(brewId, 'brew id')}`;
}

/** ADR 0010: `BREWID#<brewId>` points to the brew's sort key, for reads by id. */
export function brewRefKey(user: UserId, brewId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.brewRef}${id(brewId, 'brew id')}` };
}

export function recipeKey(user: UserId, recipeId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.recipe}${id(recipeId, 'recipe id')}` };
}

/**
 * `LOOKUPS#<YYYY-MM-DD>`: the caller's Open Food Facts fetches on that UTC day
 * (docs/05, Barcode lookup: per-user daily cap). Carries `expires_at` (TTL).
 */
export function lookupCounterKey(user: UserId, utcDay: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.lookups}${calendarDate(utcDay, 'lookup day')}` };
}

// ---- label photos (M1-T4d; ADR 0016) ----
// Every user-side item of a label photo is in the uploader's partition, so
// export (M1-T6) finds the photos under `PHOTO#` and account deletion under
// `PHOTO#`, `PHOTO_PENDING#`, `BEANPHOTOS#` and `PHOTO_UPLOADS#`.

/** `PHOTO#<photoId>`: a completed label photo of the caller, holding its bean id. */
export function labelPhotoKey(user: UserId, photoId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.labelPhoto}${id(photoId, 'photo id')}` };
}

/** `PHOTO_PENDING#<photoId>`: an upload the caller started and has not completed; TTL `expires_at`. */
export function pendingLabelPhotoKey(user: UserId, photoId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.labelPhotoPending}${id(photoId, 'photo id')}` };
}

/** `BEANPHOTOS#<beanId>`: how many label photos the caller completed for the bean (at most 3). */
export function labelPhotoCountKey(user: UserId, beanId: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.labelPhotoCount}${id(beanId, 'bean id')}` };
}

/** `PHOTO_UPLOADS#<YYYY-MM-DD>`: the label photo uploads the caller started that UTC day; TTL `expires_at`. */
export function labelPhotoUploadCounterKey(user: UserId, utcDay: string): Key {
  return { pk: userPk(user), sk: `${PREFIX.labelPhotoUploads}${calendarDate(utcDay, 'upload day')}` };
}

// ---- account deletion (M1-T6; ADR 0017, Addendum) ----

/**
 * `DELETED#<sub>` / `META`: the tombstone of a deleted account. Its own
 * partition, outside `USER#<sub>`, so emptying the user partition keeps it.
 * Every write of the caller is conditional on it not being in force.
 */
export function tombstoneKey(user: UserId): Key {
  return { pk: `${PREFIX.deletedAccount}${userPart(user)}`, sk: SORT_KEY.tombstone };
}

// ---- bean catalogue ----

export function beanPk(beanId: string): string {
  return `${PREFIX.bean}${id(beanId, 'bean id')}`;
}

export function beanMetaKey(beanId: string): Key {
  return { pk: beanPk(beanId), sk: SORT_KEY.beanMeta };
}

/** `BEAN#<beanId>` / `PHOTO#<photoId>`: a label photo of the bean for the operator. No user id (ADR 0016, D10). */
export function beanLabelPhotoKey(beanId: string, photoId: string): Key {
  return { pk: beanPk(beanId), sk: `${PREFIX.labelPhoto}${id(photoId, 'photo id')}` };
}

/** infra/README.md, Index `gsi1`: `REVIEW#UNVERIFIED` and `<createdAt UTC>#<beanId>`. */
export function reviewQueueKey(createdAt: Date, beanId: string): ReviewQueueKey {
  return { gsi1pk: REVIEW_QUEUE_PK, gsi1sk: `${utcOf(createdAt, 'bean creation time')}#${id(beanId, 'bean id')}` };
}

/** `BARCODE#<EAN-13>`: the 12- and 13-digit forms of one product give the same key. */
export function barcodeKey(ean: string): Key {
  return { pk: barcodePk(ean), sk: SORT_KEY.barcodeTarget };
}

/**
 * `BARCODE#<EAN-13>` / `OFF`: the server's Open Food Facts result for the
 * barcode, a hit (name, brand) or a miss with `expires_at` (TTL). Same
 * partition as the barcode pointer, so both forms of one product share it.
 */
export function openFoodFactsCacheKey(ean: string): Key {
  return { pk: barcodePk(ean), sk: SORT_KEY.openFoodFactsCache };
}

function barcodePk(ean: string): string {
  return `${PREFIX.barcode}${canonicalBarcode(ean)}`;
}

// ---- aggregates and rankings (written by the nightly rebuild, M3-T7; ADR 0035) ----
// Only the aggregate store files of this directory use these builders, and only
// `readAggregate` reads an aggregate item (a structural test pins both).

export function aggregateAllKey(beanId: string): Key {
  return { pk: beanPk(beanId), sk: SORT_KEY.aggregateAll };
}

export function aggregateMethodKey(beanId: string, brewMethod: Method): Key {
  return { pk: beanPk(beanId), sk: `${PREFIX.aggregateMethod}${method(brewMethod)}` };
}

/**
 * A ranking facet (docs/04 F4: filtered by origin, process, roast level, method,
 * price band). Origin is ranked by country (ADR 0035 point 14).
 */
export type RankingFacet =
  | { readonly kind: 'all' }
  | { readonly kind: 'method'; readonly value: Method }
  | { readonly kind: 'process'; readonly value: Process }
  | { readonly kind: 'roast_level'; readonly value: RoastLevel }
  | { readonly kind: 'price_band'; readonly value: PriceBand }
  | { readonly kind: 'origin'; readonly value: Origin };

function facetPart(facet: RankingFacet): string {
  // Checked at run time as well: a facet may come from a parsed query.
  const raw: unknown = facet;
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) throw new InvalidKeyError('invalid ranking facet');
  const value: unknown = 'value' in raw ? raw.value : undefined;
  const pick = (schema: z.ZodType<string>, tag: string): string => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new InvalidKeyError('invalid ranking facet');
    return `${tag}#${parsed.data}`;
  };
  switch (raw.kind) {
    case 'all':
      if (value !== undefined) throw new InvalidKeyError('invalid ranking facet');
      return 'ALL';
    case 'method':
      return pick(MethodSchema, 'METHOD');
    case 'process':
      return pick(ProcessSchema, 'PROCESS');
    case 'roast_level':
      return pick(RoastLevelSchema, 'ROAST_LEVEL');
    case 'price_band':
      return pick(PriceBandSchema, 'PRICE_BAND');
    case 'origin':
      return pick(OriginSchema, 'ORIGIN');
    default:
      throw new InvalidKeyError('invalid ranking facet');
  }
}

/** `RANK#<facet>` / `<period>`; the period is the calendar day of the nightly run (ADR 0010). */
export function rankingKey(facet: RankingFacet, period: string): Key {
  return { pk: `${PREFIX.ranking}${facetPart(facet)}`, sk: calendarDate(period, 'ranking period') };
}

// ---- parsers for sort keys read back from cursors and pointer items ----

const SHELF_SK = new RegExp(`^${PREFIX.shelf}(${ULID})$`);
const BREW_SK = new RegExp(`^${PREFIX.brew}(${UTC_MS})#(${ULID})$`);
const RECIPE_SK = new RegExp(`^${PREFIX.recipe}(${ULID})$`);
const REVIEW_SK = new RegExp(`^(${UTC_MS})#(${ULID})$`);

/** The shelf entry id of a `SHELF#` sort key, or undefined. */
export function parseShelfSortKey(sk: string): string | undefined {
  return SHELF_SK.exec(sk)?.[1];
}

/** The time and id of a `BREW#` sort key, or undefined. */
export function parseBrewSortKey(sk: string): { brewedAtUtc: string; brewId: string } | undefined {
  const match = BREW_SK.exec(sk);
  const brewedAtUtc = match?.[1];
  const brewId = match?.[2];
  if (brewedAtUtc === undefined || brewId === undefined) return undefined;
  // The pattern alone accepts 2026-13-45; the time must be one toISOString can produce.
  const date = new Date(brewedAtUtc);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== brewedAtUtc) return undefined;
  return { brewedAtUtc, brewId };
}

/** The recipe id of a `RECIPE#` sort key, or undefined. */
export function parseRecipeSortKey(sk: string): string | undefined {
  return RECIPE_SK.exec(sk)?.[1];
}

/** The bean id of a review-queue `gsi1sk`, or undefined. */
export function parseReviewQueueSortKey(gsi1sk: string): { createdAtUtc: string; beanId: string } | undefined {
  const match = REVIEW_SK.exec(gsi1sk);
  const createdAtUtc = match?.[1];
  const beanId = match?.[2];
  if (createdAtUtc === undefined || beanId === undefined) return undefined;
  const date = new Date(createdAtUtc);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAtUtc) return undefined;
  return { createdAtUtc, beanId };
}

const FACET_PK = new RegExp(`^${PREFIX.ranking}(ALL|(METHOD|PROCESS|ROAST_LEVEL|PRICE_BAND|ORIGIN)#([a-z0-9_]+))$`);
const FACET_KINDS = { METHOD: 'method', PROCESS: 'process', ROAST_LEVEL: 'roast_level', PRICE_BAND: 'price_band', ORIGIN: 'origin' } as const;

/** The facet of a `RANK#<facet>` partition key, or undefined. Every part is checked against its vocabulary schema. */
export function parseRankingPk(pk: string): RankingFacet | undefined {
  const match = FACET_PK.exec(pk);
  if (match === null) return undefined;
  if (match[1] === 'ALL') return { kind: 'all' };
  const tag = match[2];
  if (tag !== 'METHOD' && tag !== 'PROCESS' && tag !== 'ROAST_LEVEL' && tag !== 'PRICE_BAND' && tag !== 'ORIGIN') return undefined;
  const facet = { kind: FACET_KINDS[tag], value: match[3] };
  try {
    facetPart(facet as RankingFacet);
  } catch (error) {
    if (error instanceof InvalidKeyError) return undefined;
    throw error;
  }
  return facet as RankingFacet;
}

const BEAN_PK = new RegExp(`^${PREFIX.bean}(${ULID})$`);

/** The bean id of a `BEAN#<id>` partition key, or undefined. */
export function parseBeanPk(pk: string): string | undefined {
  return BEAN_PK.exec(pk)?.[1];
}

/** The kind (and method) of an aggregate sort key `AGG#ALL` or `AGG#METHOD#<method>`, or undefined. */
export function parseAggregateSortKey(sk: string): { readonly kind: 'all' } | { readonly kind: 'method'; readonly method: Method } | undefined {
  if (sk === SORT_KEY.aggregateAll) return { kind: 'all' };
  if (!sk.startsWith(PREFIX.aggregateMethod)) return undefined;
  const parsed = MethodSchema.safeParse(sk.slice(PREFIX.aggregateMethod.length));
  return parsed.success ? { kind: 'method', method: parsed.data } : undefined;
}

// Every key format of the data model (docs/05, Data model; ADR 0010), and that
// no bad part ever reaches a key.
import { describe, expect, it } from 'vitest';
import type { UserId } from '../../src/auth/user-id.ts';
import { MethodSchema } from '../../src/generated/contract.ts';
import type { Method } from '../../src/generated/contract.ts';
import {
  InvalidKeyError,
  REVIEW_QUEUE_PK,
  aggregateAllKey,
  aggregateMethodKey,
  barcodeKey,
  beanMetaKey,
  brewKey,
  brewRefKey,
  brewSortKey,
  fixedWidthUtc,
  parseBrewSortKey,
  parseRecipeSortKey,
  parseReviewQueueSortKey,
  parseShelfSortKey,
  profileKey,
  rankingKey,
  raterMarkerKey,
  recipeKey,
  reviewQueueKey,
  shelfEntryKey,
  userPk,
  utcOf,
} from '../../src/repository/index.ts';
import type { RankingFacet } from '../../src/repository/index.ts';
import { verifiedUserId } from '../events.ts';

const SUB = '3f1c2b4a-9d8e-4f70-a1b2-c3d4e5f60718';
const OTHER_SUB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER = verifiedUserId(SUB);
const ID = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DE';
const BEAN = '01JDQ8Z6V3W4X5Y6Z7A8B9C0DF';

/** Inputs that must never become part of a key. */
const BAD_IDS: readonly [string, unknown][] = [
  ['empty', ''],
  ['a separator', '#'],
  ['another partition', `USER#${OTHER_SUB}`],
  ['an id with a separator', `${ID}#X`],
  ['an id plus a suffix', `${ID}A`],
  ['lower case', ID.toLowerCase()],
  ['a Crockford-excluded letter (I)', `I${ID.slice(1)}`],
  ['a trailing newline', `${ID}\n`],
  ['whitespace', ` ${ID}`],
  ['a number', 42],
  ['undefined', undefined],
  ['null', null],
  ['an object', { toString: () => ID }],
];

const BAD_USERS: readonly [string, unknown][] = [
  ['a raw sub string', SUB],
  ['a partition key', `USER#${OTHER_SUB}`],
  ['an empty string', ''],
  ['a look-alike object', { value: OTHER_SUB }],
  ['undefined', undefined],
];

/** Bypasses the type system, as code that ignored it would. */
function forged(value: unknown): UserId {
  return value as UserId;
}

describe('user partition keys', () => {
  it('builds every user item key from the verified user id', () => {
    expect(userPk(USER)).toBe(`USER#${SUB}`);
    expect(profileKey(USER)).toEqual({ pk: `USER#${SUB}`, sk: 'PROFILE' });
    expect(shelfEntryKey(USER, ID)).toEqual({ pk: `USER#${SUB}`, sk: `SHELF#${ID}` });
    expect(brewKey(USER, '2026-11-25T10:15:30+01:00', ID)).toEqual({
      pk: `USER#${SUB}`,
      sk: `BREW#2026-11-25T09:15:30.000Z#${ID}`,
    });
    expect(brewRefKey(USER, ID)).toEqual({ pk: `USER#${SUB}`, sk: `BREWID#${ID}` });
    expect(recipeKey(USER, ID)).toEqual({ pk: `USER#${SUB}`, sk: `RECIPE#${ID}` });
  });

  it('gives two users two partitions', () => {
    expect(userPk(verifiedUserId(OTHER_SUB))).toBe(`USER#${OTHER_SUB}`);
    expect(userPk(verifiedUserId(OTHER_SUB))).not.toBe(userPk(USER));
  });

  it.each(BAD_USERS)('rejects %s as the user at run time', (_name, value) => {
    const user = forged(value);
    for (const build of [
      () => userPk(user),
      () => profileKey(user),
      () => shelfEntryKey(user, ID),
      () => brewKey(user, '2026-11-25T10:15:30Z', ID),
      () => brewRefKey(user, ID),
      () => recipeKey(user, ID),
      () => raterMarkerKey(BEAN, user),
    ]) {
      expect(build).toThrow(InvalidKeyError);
    }
  });

  it('does not accept a string user id at the type level', () => {
    // @ts-expect-error a raw string is not a UserId
    expect(() => profileKey(SUB)).toThrow(InvalidKeyError);
    // @ts-expect-error an object of the same public shape is not a UserId
    expect(() => shelfEntryKey({ value: SUB }, ID)).toThrow(InvalidKeyError); // eslint-disable-line @typescript-eslint/no-unsafe-class-instance-assignment -- deliberate forgery attempt
  });

  it.each(BAD_IDS)('rejects %s as an item id', (_name, value) => {
    const bad = value as string;
    expect(() => shelfEntryKey(USER, bad)).toThrow(InvalidKeyError);
    expect(() => brewKey(USER, '2026-11-25T10:15:30Z', bad)).toThrow(InvalidKeyError);
    expect(() => brewRefKey(USER, bad)).toThrow(InvalidKeyError);
    expect(() => recipeKey(USER, bad)).toThrow(InvalidKeyError);
  });

  it('does not echo the bad value in the error', () => {
    expect(() => shelfEntryKey(USER, `USER#${OTHER_SUB}`)).toThrow(/^invalid shelf entry id$/);
  });
});

describe('brew sort key', () => {
  it.each([
    ['Z', '2026-11-25T10:15:30Z', '2026-11-25T10:15:30.000Z'],
    ['a positive offset', '2026-11-25T00:30:00+01:00', '2026-11-24T23:30:00.000Z'],
    ['a negative offset', '2026-11-25T23:30:00-01:00', '2026-11-26T00:30:00.000Z'],
    ['nine fraction digits', '2026-11-25T10:15:30.123456789Z', '2026-11-25T10:15:30.123Z'],
    ['one fraction digit', '2026-11-25T10:15:30.5Z', '2026-11-25T10:15:30.500Z'],
  ])('normalises %s to fixed-width UTC', (_name, input, utc) => {
    expect(brewSortKey(input, ID)).toBe(`BREW#${utc}#${ID}`);
    expect(fixedWidthUtc(input)).toHaveLength(24);
  });

  it('sorts by time as a string, whatever the offset', () => {
    const earlier = brewSortKey('2026-11-25T10:00:00+05:00', ID); // 05:00Z
    const later = brewSortKey('2026-11-25T06:00:00Z', ID);
    expect(earlier < later).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a separator', '#'],
    ['a partition key', `USER#${OTHER_SUB}`],
    ['no offset', '2026-11-25T10:15:30'],
    ['lower-case t', '2026-11-25t10:15:30Z'],
    ['a date only', '2026-11-25'],
    ['a day that does not exist', '2026-02-29T10:00:00Z'],
    ['a leap second', '2026-12-31T23:59:60Z'],
    ['a time with a separator', '2026-11-25T10:15:30Z#X'],
    ['a year that leaves 0000 to 9999 in UTC', '0000-01-01T00:30:00+01:00'],
    ['a year past 9999 in UTC', '9999-12-31T23:30:00-01:00'],
    ['a number', 1_764_000_000_000],
  ])('rejects %s as the brew time', (_name, value) => {
    expect(() => brewSortKey(value as string, ID)).toThrow(InvalidKeyError);
  });

  it('round-trips through its parser', () => {
    expect(parseBrewSortKey(brewSortKey('2026-11-25T10:15:30Z', ID))).toEqual({
      brewedAtUtc: '2026-11-25T10:15:30.000Z',
      brewId: ID,
    });
  });
});

describe('bean catalogue keys', () => {
  it('builds the bean, barcode and review-queue keys', () => {
    expect(beanMetaKey(BEAN)).toEqual({ pk: `BEAN#${BEAN}`, sk: 'META' });
    expect(barcodeKey('4006381333931')).toEqual({ pk: 'BARCODE#4006381333931', sk: 'BEAN' });
    expect(barcodeKey('012345678905')).toEqual({ pk: 'BARCODE#012345678905', sk: 'BEAN' });
    expect(reviewQueueKey(new Date('2026-11-25T10:15:30+01:00'), BEAN)).toEqual({
      gsi1pk: REVIEW_QUEUE_PK,
      gsi1sk: `2026-11-25T09:15:30.000Z#${BEAN}`,
    });
    expect(REVIEW_QUEUE_PK).toBe('REVIEW#UNVERIFIED');
  });

  it('writes the review-queue time as fixed-width UTC', () => {
    const { gsi1sk } = reviewQueueKey(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), BEAN);
    expect(gsi1sk).toBe(`2026-01-02T03:04:05.006Z#${BEAN}`);
    expect(gsi1sk.indexOf('#')).toBe(24);
  });

  it('rejects an invalid or out-of-range creation time', () => {
    expect(() => reviewQueueKey(new Date('nonsense'), BEAN)).toThrow(InvalidKeyError);
    expect(() => reviewQueueKey(new Date(Date.UTC(10_000, 0, 1)), BEAN)).toThrow(InvalidKeyError);
    expect(() => utcOf(new Date(-62_198_755_200_001))).toThrow(InvalidKeyError);
  });

  it.each(BAD_IDS)('rejects %s as a bean id', (_name, value) => {
    const bad = value as string;
    expect(() => beanMetaKey(bad)).toThrow(InvalidKeyError);
    expect(() => reviewQueueKey(new Date(), bad)).toThrow(InvalidKeyError);
    expect(() => aggregateAllKey(bad)).toThrow(InvalidKeyError);
    expect(() => aggregateMethodKey(bad, 'v60')).toThrow(InvalidKeyError);
    expect(() => raterMarkerKey(bad, USER)).toThrow(InvalidKeyError);
  });

  it.each([
    ['empty', ''],
    ['a separator', '#'],
    ['a partition key', `USER#${OTHER_SUB}`],
    ['too short (11 digits)', '01234567890'],
    ['too long (14 digits)', '01234567890123'],
    ['a barcode with a separator', '4006381333931#BEAN'],
    ['letters', '40063813339AB'],
    ['non-ASCII digits', '４００６３８１３３３９３１'],
    ['a number', 4006381333931],
  ])('rejects %s as a barcode', (_name, value) => {
    expect(() => barcodeKey(value as string)).toThrow(InvalidKeyError);
  });
});

describe('aggregate, rater and ranking keys', () => {
  it('builds the aggregate keys for every method in the vocabulary', () => {
    expect(aggregateAllKey(BEAN)).toEqual({ pk: `BEAN#${BEAN}`, sk: 'AGG#ALL' });
    for (const method of MethodSchema.options) {
      expect(aggregateMethodKey(BEAN, method)).toEqual({ pk: `BEAN#${BEAN}`, sk: `AGG#METHOD#${method}` });
    }
  });

  it.each([
    ['empty', ''],
    ['a separator', '#'],
    ['ALL, to collide with the all-methods item', 'ALL'],
    ['a partition key', `USER#${OTHER_SUB}`],
    ['an upper-case id', 'V60'],
    ['an id plus a separator', 'v60#x'],
  ])('rejects %s as a method', (_name, value) => {
    expect(() => aggregateMethodKey(BEAN, value as Method)).toThrow(InvalidKeyError);
  });

  it('builds the rater marker from the verified user id only', () => {
    expect(raterMarkerKey(BEAN, USER)).toEqual({ pk: `BEAN#${BEAN}`, sk: `RATER#${SUB}` });
    // @ts-expect-error a raw string is not a UserId
    expect(() => raterMarkerKey(BEAN, SUB)).toThrow(InvalidKeyError);
  });

  it('builds the ranking keys for each facet', () => {
    expect(rankingKey({ kind: 'all' }, '2026-11-25')).toEqual({ pk: 'RANK#ALL', sk: '2026-11-25' });
    expect(rankingKey({ kind: 'method', value: 'v60' }, '2026-11-25')).toEqual({ pk: 'RANK#METHOD#v60', sk: '2026-11-25' });
    expect(rankingKey({ kind: 'process', value: 'washed' }, '2026-11-25').pk).toBe('RANK#PROCESS#washed');
    expect(rankingKey({ kind: 'roast_level', value: 'medium_light' }, '2026-11-25').pk).toBe('RANK#ROAST_LEVEL#medium_light');
    expect(rankingKey({ kind: 'price_band', value: 'under_15' }, '2026-11-25').pk).toBe('RANK#PRICE_BAND#under_15');
  });

  it.each([
    ['an unknown kind', { kind: 'origin', value: 'ethiopia' }],
    ['a value from another list', { kind: 'method', value: 'washed' }],
    ['an injected value', { kind: 'process', value: 'washed#x' }],
    ['an empty value', { kind: 'price_band', value: '' }],
    ['all with a value', { kind: 'all', value: 'v60' }],
    ['no kind', {}],
    ['null', null],
  ])('rejects %s as a ranking facet', (_name, facet) => {
    expect(() => rankingKey(facet as RankingFacet, '2026-11-25')).toThrow(InvalidKeyError);
  });

  it.each([
    ['empty', ''],
    ['a separator', '#'],
    ['a day that does not exist', '2026-02-30'],
    ['a timestamp', '2026-11-25T00:00:00Z'],
    ['a date with a suffix', '2026-11-25#x'],
  ])('rejects %s as a ranking period', (_name, period) => {
    expect(() => rankingKey({ kind: 'all' }, period)).toThrow(InvalidKeyError);
  });
});

describe('sort key parsers', () => {
  it('accept their own keys and nothing else', () => {
    expect(parseShelfSortKey(`SHELF#${ID}`)).toBe(ID);
    expect(parseRecipeSortKey(`RECIPE#${ID}`)).toBe(ID);
    expect(parseReviewQueueSortKey(`2026-11-25T09:15:30.000Z#${BEAN}`)).toEqual({
      createdAtUtc: '2026-11-25T09:15:30.000Z',
      beanId: BEAN,
    });
    for (const sk of ['', '#', 'PROFILE', `SHELF#${ID}#x`, `RECIPE#${ID}`, `BREWID#${ID}`, `USER#${OTHER_SUB}`]) {
      expect(parseShelfSortKey(sk)).toBeUndefined();
    }
    for (const sk of ['', `BREWID#${ID}`, `BREW#${ID}`, `BREW#2026-13-45T09:15:30.000Z#${ID}`, `BREW#2026-11-25T09:15:30Z#${ID}`]) {
      expect(parseBrewSortKey(sk)).toBeUndefined();
    }
    expect(parseRecipeSortKey(`SHELF#${ID}`)).toBeUndefined();
    expect(parseReviewQueueSortKey(`2026-02-30T09:15:30.000Z#${BEAN}`)).toBeUndefined();
  });
});
